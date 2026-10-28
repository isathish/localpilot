import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LocalPilotApi } from '../extension';
import { autoDetectProviders, discoverDockerProviders } from '../providers/discovery';

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
        api.stop(id);
        reject(new Error(`session ${id} still running after ${timeoutMs} ms; transcript so far: ${transcript(id)}`));
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
    this.timeout(240_000);
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
    // The agent may legitimately run a command to verify its edit; with no human to answer, allow it.
    await cfg.update('approvals.terminal', 'always', vscode.ConfigurationTarget.Global);
    await cfg.update('showWelcomeOnStartup', false, vscode.ConfigurationTarget.Global);
    // Test prompts must not pull skills from GitHub into the real ~/.localpilot/skills.
    await cfg.update('skills.autoInstall', 'off', vscode.ConfigurationTarget.Global);
    // These tests assert on files in the workspace itself; the isolated-worktree test below turns isolation on explicitly.
    await cfg.update('worktrees.mode', 'off', vscode.ConfigurationTarget.Global);
    // Load the model with the context size real runs use, so the first test's budget is not spent on a cold load.
    const warm = await api.runPrompt('Reply with the single word OK.', 'ask');
    await waitForRun(warm, 200_000);
  });

  test('multitask mode: the coordinator delegates to background workers that run in parallel', async function () {
    this.timeout(300_000);
    const id = await api.runPrompt('Two independent pieces of work: (1) create the file alpha.txt in the workspace root containing exactly "alpha"; (2) create the file beta.txt in the workspace root containing exactly "beta". When both are done, confirm that both files exist.', 'multitask');
    await waitForRun(id, 280_000);
    const session = api.getSession(id)!;
    const calls = session.messages.flatMap((m) => m.toolCalls ?? []).map((c) => c.name);
    assert.ok(calls.some((c) => /^run_(todos_parallel|parallel_subagents|subagent)$/.test(c)), `multitask mode must delegate to workers, got tools: ${calls.join(', ')}; ${transcript(id)}`);
    assert.ok(!calls.some((c) => c === 'write_file' || c === 'edit_file'), `the coordinator must not edit files itself, got tools: ${calls.join(', ')}`);
    const a = await fs.readFile(path.join(root, 'alpha.txt'), 'utf8').catch(() => '');
    const b = await fs.readFile(path.join(root, 'beta.txt'), 'utf8').catch(() => '');
    assert.ok(a.trim() === 'alpha' && b.trim() === 'beta', `workers should have created both files (alpha=${JSON.stringify(a)}, beta=${JSON.stringify(b)}); ${transcript(id)}`);
  });

  test('isolated worktree: the agent edits a copy, the workspace stays untouched until Apply brings the change over', async function () {
    this.timeout(240_000);
    const cp = await import('child_process');
    const sh = (cmd: string) => cp.execSync(cmd, { cwd: root, stdio: 'pipe' }).toString();
    if (!(await fs.stat(path.join(root, '.git')).catch(() => undefined))) {
      sh('git init -q && git config user.email e2e@localpilot && git config user.name e2e');
    }
    await fs.writeFile(path.join(root, 'notes.md'), '# Notes\n');
    sh('git add -A && git commit -q -m base --allow-empty');
    const cfg = vscode.workspace.getConfiguration('localpilot');
    await cfg.update('worktrees.mode', 'always', vscode.ConfigurationTarget.Global);
    try {
      const file = 'e2e-isolated.txt';
      const id = await api.runPrompt(`Use the write_file tool to create ${file} in the workspace root containing exactly the text: isolated hello\nThen reply "done".`, 'agent');
      await waitForRun(id, 200_000);
      const session = api.getSession(id)!;
      assert.ok(session.worktree, `session should have a worktree: ${transcript(id)}`);
      assert.ok(!session.worktree!.path.startsWith(root), 'worktree lives outside the workspace');
      const inWorktree = await fs.readFile(path.join(session.worktree!.path, file), 'utf8').catch(() => undefined);
      assert.strictEqual(inWorktree?.trim(), 'isolated hello', `file should exist in the worktree: ${transcript(id)}`);
      assert.ok(!(await fs.stat(path.join(root, file)).catch(() => undefined)), 'workspace must not have the file before Apply');
      assert.strictEqual(await fs.readFile(path.join(session.worktree!.path, 'notes.md'), 'utf8'), '# Notes\n', 'worktree started from the workspace state');
      const res = await api.applyWorktree(id);
      assert.ok(res && res.files >= 1 && res.conflicts.length === 0, `apply result: ${JSON.stringify(res)}`);
      assert.strictEqual((await fs.readFile(path.join(root, file), 'utf8')).trim(), 'isolated hello', 'Apply brought the file into the workspace');
      assert.ok(/\?\? e2e-isolated.txt|A  e2e-isolated.txt/.test(sh('git status --short')), 'applied as an uncommitted change');
      const wtPath = session.worktree!.path;
      await api.discardWorktree(id);
      assert.ok(!(await fs.stat(wtPath).catch(() => undefined)), 'discard removes the worktree');
      assert.ok(!api.getSession(id)!.worktree, 'session no longer has a worktree');
    } finally {
      await cfg.update('worktrees.mode', 'off', vscode.ConfigurationTarget.Global);
    }
  });

  test('api exposes the real extension version', () => {
    const ext = vscode.extensions.getExtension('localpilot.localpilot-agent')!;
    assert.strictEqual(api.version, ext.packageJSON.version);
    assert.match(api.version, /^\d+\.\d+\.\d+/);
  });

  test('auto-detection finds the running Ollama server and any model containers published by Docker', async function () {
    this.timeout(30_000);
    const log = vscode.window.createOutputChannel('LocalPilot e2e', { log: true });
    const report = await autoDetectProviders(log, { write: false });
    log.dispose();
    const ollama = report.results.find((r) => r.ok && r.type === 'ollama' && /:11434$/.test(r.baseUrl));
    assert.ok(ollama, `expected the local Ollama to be detected: ${report.results.map((r) => `${r.id}:${r.ok}`).join(', ')}`);
    assert.ok(ollama.models.length > 0 && report.recommended, 'models listed and a recommendation made');

    // When a model-server container is running (e.g. `docker run -p 11435:11434 ollama/ollama`), it must be
    // discovered on its *host* port and proposed as a new provider unless already configured.
    const containers = await discoverDockerProviders();
    for (const c of containers) {
      const r = report.results.find((x) => x.baseUrl === c.baseUrl);
      assert.ok(r, `container ${c.id} (${c.baseUrl}) was probed`);
      assert.strictEqual(r.source, r.configured ? 'settings' : 'docker');
      if (r.ok && !r.configured) {
        assert.ok(report.added.some((a) => a.baseUrl === c.baseUrl), `${c.id} proposed for addition`);
      }
    }
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

  const toolsUsed = (id: string) => (api.getSession(id)?.messages ?? []).filter((m) => m.role === 'tool').map((m) => m.toolName ?? '');
  const finalAnswer = (id: string) => [...(api.getSession(id)?.messages ?? [])].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content ?? '';

  test('agent reads an existing file, understands it and fixes it in place with edit_file', async function () {
    this.timeout(240_000);
    const file = path.join(root, 'calc.py');
    await fs.writeFile(file, 'def add(a, b):\n    return a - b  # BUG: should add\n\n\ndef mul(a, b):\n    return a * b\n', 'utf8');
    const id = await api.runPrompt('calc.py has a bug in add(): it subtracts instead of adding. Read the file, then fix only that line with edit_file so add() returns a + b. Keep mul() unchanged. Reply "fixed" when done.', 'agent');
    await waitForRun(id, 230_000);
    const used = toolsUsed(id);
    assert.ok(used.includes('read_file'), `expected read_file, got ${used.join(',')}; ${transcript(id)}`);
    assert.ok(used.some((t) => t === 'edit_file' || t === 'write_file'), `expected an edit, got ${used.join(',')}; ${transcript(id)}`);
    const after = await fs.readFile(file, 'utf8');
    assert.match(after, /return a \+ b/, `file not fixed:\n${after}\n${transcript(id)}`);
    assert.match(after, /def mul\(a, b\):\s*\n\s*return a \* b/, `mul() should be untouched:\n${after}`);
  });

  test('ask mode understands the workspace: finds where a symbol is defined', async function () {
    this.timeout(240_000);
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'billing.py'), 'def compute_total(items):\n    return sum(i.price * i.qty for i in items)\n', 'utf8');
    await fs.writeFile(path.join(root, 'src', 'models.py'), 'class Item:\n    def __init__(self, price, qty):\n        self.price = price\n        self.qty = qty\n', 'utf8');
    await fs.writeFile(path.join(root, 'README.md'), '# Shop\n\nA tiny shop example.\n', 'utf8');
    const id = await api.runPrompt('Which file in this workspace defines the function compute_total? Search the workspace with the tools, then answer with the file path only.', 'ask');
    await waitForRun(id, 230_000);
    const used = toolsUsed(id);
    assert.ok(used.length > 0, `ask mode should still use read-only tools; ${transcript(id)}`);
    assert.ok(!used.some((t) => /^(write_file|edit_file|run_command|delete_path)$/.test(t)), `ask mode must not mutate: ${used.join(',')}`);
    assert.match(finalAnswer(id), /billing\.py/, `answer should name billing.py: ${finalAnswer(id)}\n${transcript(id)}`);
  });

  test('the active editor is attached as context and the model reasons about it', async function () {
    this.timeout(240_000);
    const doc = await vscode.workspace.openTextDocument(path.join(root, 'src', 'billing.py'));
    await vscode.window.showTextDocument(doc);
    const id = await api.runPrompt('What is the name of the function in the attached file? Answer with the function name only, no tools.', 'ask', ['selection']);
    await waitForRun(id, 230_000);
    const user = api.getSession(id)!.messages.find((m) => m.role === 'user')!;
    assert.match(user.content, /<attachment path="src\/billing\.py"/, 'active file inlined into the prompt');
    assert.match(finalAnswer(id), /compute_total/, `answer: ${finalAnswer(id)}`);
  });

  test('skill-based execution: a workspace SKILL.md is discovered, loaded with load_skill and followed', async function () {
    this.timeout(240_000);
    const skillDir = path.join(root, '.localpilot', 'skills', 'greeting');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: greeting\ndescription: Create the project greeting file in the required format\n---\n# Greeting skill\n\nWhen asked to create a greeting:\n1. Use write_file to create `GREETING.txt` in the workspace root.\n2. The file must contain exactly one line: `Hello from the greeting skill`\n3. Do not create any other file. Reply "greeted" when done.\n', 'utf8');
    await vscode.commands.executeCommand('localpilot.reloadSkills');
    await new Promise((r) => setTimeout(r, 500));
    const id = await api.runPrompt('/skill greeting create the greeting', 'agent');
    await waitForRun(id, 230_000);
    // `/skill <name>` preloads the skill's instructions into the request, so the model never has to call load_skill.
    const pre = api.getSession(id)!.messages.find((m) => m.role === 'user' && m.meta?.hidden && /<skill name="greeting"/.test(m.content));
    assert.ok(pre && /you were asked to use it/.test(pre.content), `greeting skill preloaded: ${transcript(id)}`);
    const txt = await fs.readFile(path.join(root, 'GREETING.txt'), 'utf8').catch((e) => {
      throw new Error(`${e.message}\n${transcript(id)}`);
    });
    assert.match(txt, /Hello from the greeting skill/);
  });

  test('parallel subagents: run_parallel_subagents fans out real child agents concurrently and merges their reports', async function () {
    this.timeout(300_000);
    await fs.writeFile(path.join(root, 'ALPHA.md'), '# Alpha\n\nThe alpha module handles authentication tokens.\n', 'utf8');
    await fs.writeFile(path.join(root, 'BETA.md'), '# Beta\n\nThe beta module handles billing invoices.\n', 'utf8');
    const id = await api.runPrompt(
      'Call the run_parallel_subagents tool exactly once with two tasks, both using agent "explore": task 1 prompt "Read ALPHA.md and report in one sentence what the alpha module handles", task 2 prompt "Read BETA.md and report in one sentence what the beta module handles". Then summarise both reports in two lines.',
      'agent'
    );
    await waitForRun(id, 290_000);
    const session = api.getSession(id)!;
    const fan = session.messages.find((m) => m.role === 'tool' && m.toolName === 'run_parallel_subagents');
    assert.ok(fan, `run_parallel_subagents was not executed: ${transcript(id)}`);
    assert.match(fan.content, /## Task 1 \(explore\)/, 'first child report present');
    assert.match(fan.content, /## Task 2 \(explore\)/, 'second child report present');
    assert.match(fan.content, /authentication/i, `child 1 read ALPHA.md: ${fan.content.slice(0, 400)}`);
    assert.match(fan.content, /billing|invoice/i, `child 2 read BETA.md: ${fan.content.slice(0, 400)}`);
    assert.match(finalAnswer(id), /auth|billing|invoice/i, `parent summarised the reports: ${finalAnswer(id)}`);
  });

  test('vague request: "fix this" is clarified from the active editor and the bug is actually fixed', async function () {
    this.timeout(240_000);
    const rel = 'src/mathutil.py';
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, rel), 'def add(a, b):\n    """Return the sum of a and b."""\n    return a - b\n', 'utf8');
    const doc = await vscode.workspace.openTextDocument(path.join(root, rel));
    await vscode.window.showTextDocument(doc, { preview: false });
    await new Promise((r) => setTimeout(r, 300));

    const id = await api.runPrompt('fix this', 'agent');
    await waitForRun(id, 230_000);
    const session = api.getSession(id)!;
    const steer = session.messages.find((m) => m.role === 'user' && m.meta?.hidden && /may be ambiguous/.test(m.content));
    assert.ok(steer, `clarification steer was injected: ${transcript(id)}`);
    assert.match(steer.content, /mathutil\.py/, 'snapshot names the active file');
    const fixed = await fs.readFile(path.join(root, rel), 'utf8');
    assert.match(fixed, /return\s+a\s*\+\s*b/, `bug fixed from context alone: ${fixed}\n${transcript(id)}`);
  });

  test('task splitting: checklist items with agent+prompt run as parallel subagents and are ticked off', async function () {
    this.timeout(300_000);
    const id = await api.runPrompt(
      'Call manage_todos exactly once with two pending items: {"id":"1","title":"Create ONE.txt","status":"pending","agent":"coder","prompt":"Use write_file to create ONE.txt in the workspace root containing exactly: one"} and {"id":"2","title":"Create TWO.txt","status":"pending","agent":"coder","prompt":"Use write_file to create TWO.txt in the workspace root containing exactly: two"}. Then call run_todos_parallel once. Then reply "done".',
      'agent'
    );
    await waitForRun(id, 290_000);
    const session = api.getSession(id)!;
    const fan = session.messages.find((m) => m.role === 'tool' && m.toolName === 'run_todos_parallel');
    assert.ok(fan, `run_todos_parallel was not executed: ${transcript(id)}`);
    assert.match(fan.content, /2\/2 items completed/, `both delegated items completed: ${fan.content.slice(0, 300)}`);
    assert.ok(session.todos?.length === 2 && session.todos.every((t) => t.status === 'done'), `todos ticked off: ${JSON.stringify(session.todos)}`);
    assert.ok(session.todos.every((t) => t.agent === 'coder' && t.result), 'items keep their agent and carry the report');
    assert.match(await fs.readFile(path.join(root, 'ONE.txt'), 'utf8'), /one/i);
    assert.match(await fs.readFile(path.join(root, 'TWO.txt'), 'utf8'), /two/i);
  });

  test('skill recommendation: a strongly matching skill is preloaded into the request without /skill', async function () {
    this.timeout(240_000);
    const skillDir = path.join(root, '.localpilot', 'skills', 'banner');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: banner\ndescription: Create the project banner file. Use for "banner", "create the banner".\n---\n# Banner skill\n\n1. Use write_file to create `BANNER.txt` in the workspace root.\n2. It must contain exactly one line: `Banner made by the banner skill`\n3. Reply "bannered" when done.\n', 'utf8');
    await vscode.commands.executeCommand('localpilot.reloadSkills');
    await new Promise((r) => setTimeout(r, 500));
    const id = await api.runPrompt('create the banner for this project', 'agent');
    await waitForRun(id, 230_000);
    const session = api.getSession(id)!;
    // "create the banner" is a quoted trigger phrase → strong match → the whole skill is preloaded, not just hinted.
    const pre = session.messages.find((m) => m.role === 'user' && m.meta?.hidden && /<skill name="banner"/.test(m.content));
    assert.ok(pre && /is loaded below because it matches this request/.test(pre.content), `banner skill preloaded: ${transcript(id)}`);
    assert.match(await fs.readFile(path.join(root, 'BANNER.txt'), 'utf8').catch(() => ''), /banner skill/i, transcript(id));
  });

  test('registry auto-install: a matching skill from GitHub is installed into the workspace and loaded into the request', async function () {
    // Needs github.com; opt in so offline runs stay green.
    if (!process.env.LOCALPILOT_E2E_NETWORK) {
      this.skip();
    }
    this.timeout(300_000);
    const cfg = vscode.workspace.getConfiguration('localpilot');
    await cfg.update('skills.repositories', ['anthropics/skills/skills'], vscode.ConfigurationTarget.Global);
    await cfg.update('skills.autoInstallScope', 'workspace', vscode.ConfigurationTarget.Global);
    await cfg.update('skills.autoInstall', 'auto', vscode.ConfigurationTarget.Global);
    const dir = path.join(root, '.localpilot', 'skills', 'pdf');
    try {
      const id = await api.runPrompt('Which Python library do you recommend to fill in the fields of a PDF form? Answer in one sentence, no tools.', 'ask');
      await waitForRun(id, 280_000);
      const session = api.getSession(id)!;
      assert.ok(await fs.stat(path.join(dir, 'SKILL.md')).catch(() => undefined), `pdf skill installed into the workspace: ${transcript(id)}`);
      const pre = session.messages.find((m) => m.role === 'user' && m.meta?.hidden && /<skill name="pdf"/.test(m.content));
      assert.ok(pre, `installed skill loaded into the request: ${transcript(id)}`);
      const answer = session.messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
      assert.match(answer, /py(pdf|pdf2|mupdf)|fitz|pdfrw|reportlab|pdftk/i, transcript(id));
    } finally {
      await cfg.update('skills.autoInstall', 'off', vscode.ConfigurationTarget.Global);
      await cfg.update('skills.autoInstallScope', undefined, vscode.ConfigurationTarget.Global);
      await cfg.update('skills.repositories', undefined, vscode.ConfigurationTarget.Global);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

