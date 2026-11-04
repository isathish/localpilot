import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { globToRegExp, RelativePattern as ShimRP, Uri as ShimUri, workspace as shimWs } from '../cli/vscodeShim';
import { shellInvocation } from '../terminal/shell';
import { inDir, samePath, TerminalManager } from '../terminal/terminalManager';
import { runCommandTool } from '../tools/terminal';
import { ToolContext } from '../types';

const EXT_ROOT = path.resolve(__dirname, '..', '..');

suite('LocalPilot terminal integration', () => {
  let log: vscode.LogOutputChannel;
  let tm: TerminalManager;

  suiteSetup(async function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension('localpilot.localpilot-agent')!;
    await ext.activate();
    log = vscode.window.createOutputChannel('LocalPilot terminal test', { log: true });
    tm = new TerminalManager({ extensionUri: ext.extensionUri, globalStorageUri: vscode.Uri.file(os.tmpdir()) } as vscode.ExtensionContext, log);
  });
  suiteTeardown(() => tm.dispose());

  test('terminal commands, context menu entries and the LocalPilot terminal profile are contributed', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['localpilot.openTerminal', 'localpilot.explainTerminal', 'localpilot.fixTerminal', 'localpilot.attachTerminal', 'localpilot.installCli']) {
      assert.ok(commands.includes(id), `missing ${id}`);
    }
    const c = vscode.extensions.getExtension('localpilot.localpilot-agent')!.packageJSON.contributes;
    assert.ok(c.menus['terminal/context'].some((m: { command: string }) => m.command === 'localpilot.fixTerminal'));
    assert.strictEqual(c.terminal.profiles[0].id, 'localpilot.terminalProfile');
    assert.strictEqual(c.terminal.profiles[0].icon, 'localpilot-logo', 'terminal profile uses the brand glyph');
    // Brand icon font: contributed glyphs exist and the font file ships.
    assert.strictEqual(c.icons['localpilot-logo'].default.fontPath, 'media/localpilot.woff');
    assert.ok(require('fs').existsSync(path.join(EXT_ROOT, 'media', 'localpilot.woff')), 'media/localpilot.woff must be built (npm run icons)');
    assert.strictEqual(c.commands.find((x: { command: string }) => x.command === 'localpilot.openChat').icon, '$(localpilot-logo)');
    assert.strictEqual(c.configuration.properties['localpilot.terminal.runInIntegratedTerminal'].default, true);
  });

  test('openCliTerminal creates a branded terminal with the CLI shim on PATH', async function () {
    this.timeout(15_000);
    tm.cliEnv = { PATH: `/lp-shim-bin:${process.env.PATH ?? ''}`, LOCALPILOT_CLI: '/x/dist/cli.js' };
    const term = tm.openCliTerminal();
    try {
      assert.strictEqual(term.name, 'LocalPilot');
      const opts = term.creationOptions as vscode.TerminalOptions;
      assert.ok(opts.env?.PATH?.startsWith('/lp-shim-bin:'), 'shim dir must be first on PATH');
      assert.strictEqual(opts.env?.LOCALPILOT_CLI, '/x/dist/cli.js');
      assert.ok(opts.iconPath instanceof vscode.Uri && opts.iconPath.fsPath.endsWith('icon.svg'), 'branded icon');
      assert.ok(opts.color instanceof vscode.ThemeColor);
      assert.ok(String(opts.message).includes('LocalPilot'));
    } finally {
      term.dispose();
    }
  });

  test('format() produces a prompt block and reports when nothing was captured', () => {
    assert.match(tm.format(undefined), /<terminal_output>No terminal command/);
    const term = vscode.window.createTerminal('probe');
    try {
      const block = tm.format({ terminal: term, terminalName: 'probe', command: 'npm test', cwd: '/w', output: 'x'.repeat(30_000), exitCode: 1, startedAt: 0, endedAt: 1 }, 2000);
      assert.match(block, /<terminal_output terminal="probe" cwd="\/w" exit_code="1">\n\$ npm test\n/);
      assert.ok(block.length < 2600, 'long output is trimmed head+tail');
      assert.match(block, /chars omitted/);
    } finally {
      term.dispose();
    }
  });

  test('run() executes through shell integration when the shell provides it, else returns undefined for the fallback', async function () {
    this.timeout(40_000);
    const r = await tm.run('test-session', 'echo lp-marker-$((20+22))', EXT_ROOT, new AbortController().signal, 20_000, false);
    if (!r || /\[timed out after/.test(r.output)) {
      // Shell integration never attached, or attached but never reported the command end (headless CI shells under xvfb) —
      // the tool falls back to a child process in both cases, so there is nothing to assert here.
      this.skip();
    }
    assert.match(r.output, /lp-marker-42/);
    assert.strictEqual(r.exitCode, 0);
    // `(exit 3)` is a POSIX idiom; PowerShell (the default shell on Windows runners) reports 1 for it. `cmd /c exit 3`
    // yields a real exit status 3 from both PowerShell and cmd.exe.
    const fail = await tm.run('test-session', process.platform === 'win32' ? 'cmd /c "exit 3"' : '(exit 3)', EXT_ROOT, new AbortController().signal, 20_000, false);
    // Headless CI shells (Linux and macOS runners) often attach shell integration but report no exit code for the
    // second command; the tool then falls back to a child process. Only assert the code when the shell provided one.
    if (fail?.exitCode !== undefined) {
      // PowerShell on Windows runners surfaces a generic 1 for a failing child; POSIX shells report the real code.
      const expected = process.platform === 'win32' ? [1, 3] : [3];
      assert.ok(expected.includes(fail.exitCode), `exit code ${fail.exitCode} not in ${expected.join('/')}`);
      assert.ok(expected.includes(tm.lastFailure()?.exitCode ?? -1), 'last failure recorded');
    }
    // The agent terminal is reused per session and branded.
    const agentTerms = vscode.window.terminals.filter((t) => t.name === 'LocalPilot Agent');
    assert.strictEqual(agentTerms.length, 1);
    assert.ok(tm.recordCount >= 1, 'executions are recorded for @terminal');
    agentTerms[0].dispose();
  });
});

/** OpenAI-compatible mock: lists one model and answers any chat with a fixed string (streaming or not). */
function mockOpenAI(reply: string): Promise<{ url: string; close(): void; requests: string[] }> {
  const requests: string[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'mock-coder', object: 'model' }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        const stream = /"stream"\s*:\s*true/.test(body);
        if (stream) {
          res.setHeader('content-type', 'text/event-stream');
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply }, index: 0 }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: () => srv.close(), requests })));
}

/** OpenAI-compatible mock that streams one scripted turn per chat request: a tool call, or final text. */
function mockScripted(turns: ({ tool: string; args: Record<string, unknown> } | { text: string })[]): Promise<{ url: string; close(): void; chats: number }> {
  const state = { chats: 0 };
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'mock-coder', object: 'model' }] }));
        return;
      }
      if (req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      const turn = turns[Math.min(state.chats++, turns.length - 1)];
      const sse = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      res.setHeader('content-type', 'text/event-stream');
      if ('tool' in turn) {
        sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${state.chats}`, type: 'function', function: { name: turn.tool, arguments: JSON.stringify(turn.args) } }] } }] });
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        sse({ choices: [{ index: 0, delta: { content: turn.text } }] });
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: () => srv.close(), get chats() { return state.chats; } })
    )
  );
}

suite('LocalPilot CLI (dist/cli.js)', () => {
  const cli = path.join(EXT_ROOT, 'dist', 'cli.js');
  // The built-in local providers are merged in too; turn them off so a server on this machine cannot affect the tests.
  const noDefaults = ['ollama', 'lmstudio', 'llamacpp', 'vllm'].map((id) => ({ id, enabled: false }));
  let home: string;
  const run = (args: string[], opts: { cwd?: string; input?: string } = {}) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      // HOME is redirected so the CLI reads ~/.localpilot/config.json from the sandbox, not the developer's machine.
      const child = cp.spawn(process.execPath, [cli, ...args], { cwd: opts.cwd ?? home, env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1', XDG_CONFIG_HOME: path.join(home, '.config') } });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      if (opts.input !== undefined) {
        child.stdin.end(opts.input);
      } else {
        child.stdin.end();
      }
      child.on('close', (code) => resolve({ code, out, err }));
    });

  suiteSetup(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-cli-home-'));
    await fs.mkdir(path.join(home, 'Library', 'Application Support', 'Code', 'User'), { recursive: true });
    await fs.mkdir(path.join(home, '.config', 'Code', 'User'), { recursive: true });
  });
  suiteTeardown(() => fs.rm(home, { recursive: true, force: true }));

  test('--help and --version work without any server', async function () {
    this.timeout(20_000);
    const h = await run(['--help']);
    assert.strictEqual(h.code, 0);
    assert.match(h.out, /LocalPilot/);
    assert.match(h.out, /localpilot models/);
    assert.match(h.out, /--yes/);
    const v = await run(['--version']);
    assert.strictEqual(v.code, 0);
    assert.strictEqual(v.out.trim(), vscode.extensions.getExtension('localpilot.localpilot-agent')!.packageJSON.version);
  });

  test('exits with a clear error when no model server is reachable', async function () {
    this.timeout(30_000);
    await fs.mkdir(path.join(home, '.localpilot'), { recursive: true });
    await fs.writeFile(path.join(home, '.localpilot', 'config.json'), JSON.stringify({ providers: [{ id: 'dead', type: 'openai', baseUrl: 'http://127.0.0.1:9/v1' }, ...noDefaults] }));
    const r = await run(['--no-mcp', '-p', 'hello']);
    assert.strictEqual(r.code, 2);
    assert.match(r.err, /No local models found|unreachable|doctor/i);
  });

  test('models / doctor / a real one-shot run against an OpenAI-compatible server, reading providers from ~/.localpilot/config.json', async function () {
    this.timeout(60_000);
    const srv = await mockOpenAI('The answer is **42**.');
    try {
      await fs.writeFile(path.join(home, '.localpilot', 'config.json'), JSON.stringify({ providers: [{ id: 'mock', type: 'openai', baseUrl: srv.url, displayName: 'Mock' }, ...noDefaults], defaultModel: 'mock/mock-coder' }));
      const models = await run(['models']);
      assert.strictEqual(models.code, 0, models.err);
      assert.match(models.out, /mock\/mock-coder/);
      const doctor = await run(['doctor', '--no-mcp']);
      assert.strictEqual(doctor.code, 0, doctor.err);
      assert.match(doctor.out, /Mock.*1 model/);
      assert.match(doctor.out, /default model: mock\/mock-coder/);
      const ws = path.join(home, 'ws');
      await fs.mkdir(ws, { recursive: true });
      const r = await run(['--ask', '--print', '--no-mcp', 'what is the answer?'], { cwd: ws });
      assert.strictEqual(r.code, 0, r.err);
      assert.strictEqual(r.out.trim(), 'The answer is **42**.');
      assert.ok(srv.requests.some((q) => q.includes('/v1/chat/completions')), 'the CLI must call the model server');
      // Piped stdin is treated as the prompt.
      const piped = await run(['--ask', '--no-mcp'], { cwd: ws, input: 'again?' });
      assert.strictEqual(piped.code, 0, piped.err);
      assert.strictEqual(piped.out.trim(), 'The answer is **42**.');
    } finally {
      srv.close();
    }
  });

  test('providers lists the built-in local providers, and providers add keeps them', async function () {
    this.timeout(60_000);
    const file = path.join(home, '.localpilot', 'config.json');
    try {
      await fs.rm(file, { force: true });
      const before = await run(['providers']);
      assert.match(before.out, /ollama/, before.out + before.err);
      assert.doesNotMatch(before.out, /No providers configured/);
      await run(['providers', 'add', 'anthropic', '--key', 'x']);
      const after = await run(['providers']);
      assert.match(after.out, /ollama/, after.out + after.err);
      assert.match(after.out, /anthropic/, after.out + after.err);
    } finally {
      await fs.rm(file, { force: true });
      await fs.rm(path.join(home, '.localpilot', 'keys.json'), { force: true });
    }
  });

  test('scan rejects unknown options and bad --fail-on values, and scans "." as the whole workspace', async function () {
    this.timeout(60_000);
    const ws = path.join(home, 'ws-scan');
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(path.join(ws, 'a.js'), 'export const a = 1;\n');
    const bad = await run(['scan', '--offline', '--fail-on=nope'], { cwd: ws });
    assert.strictEqual(bad.code, 2, bad.out + bad.err);
    assert.match(bad.err, /--fail-on must be one of/);
    const unknown = await run(['scan', '--offline', '--yess'], { cwd: ws });
    assert.strictEqual(unknown.code, 2, unknown.out + unknown.err);
    assert.match(unknown.err, /unknown option --yess/);
    const dot = await run(['scan', '--offline', '--fail-on=none', '.'], { cwd: ws });
    assert.strictEqual(dot.code, 0, dot.out + dot.err);
    assert.doesNotMatch(dot.out, /\b0 files/);
    const missing = await run(['scan', '--offline', 'no-such-dir'], { cwd: ws });
    assert.strictEqual(missing.code, 2, missing.out + missing.err);
  });

  test('get_diagnostics works in the CLI (no language servers) and does not crash the process', async function () {
    this.timeout(60_000);
    const srv = await mockScripted([{ tool: 'get_diagnostics', args: { path: 'a.js' } }, { text: 'No problems found.' }]);
    try {
      await fs.mkdir(path.join(home, '.localpilot'), { recursive: true });
      await fs.writeFile(path.join(home, '.localpilot', 'config.json'), JSON.stringify({ providers: [{ id: 'mock', type: 'openai', baseUrl: srv.url }, ...noDefaults], defaultModel: 'mock/mock-coder' }));
      const ws = path.join(home, 'ws-diag');
      await fs.mkdir(ws, { recursive: true });
      await fs.writeFile(path.join(ws, 'a.js'), 'export const a = 1;\n');
      const r = await run(['--ask', '--print', '--no-mcp', 'any errors in a.js?'], { cwd: ws });
      assert.strictEqual(r.code, 0, `exit ${r.code}\n${r.err}`);
      assert.doesNotMatch(r.err, /ReferenceError|is not a function/);
      assert.strictEqual(r.out.trim(), 'No problems found.');
      assert.ok(srv.chats >= 2, 'the tool result went back to the model');
    } finally {
      srv.close();
    }
  });
});

suite('CLI shim', () => {
  test('findFiles with a RelativePattern searches its own folder and honours the exclude pattern', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lp-shim-')));
    try {
      await fs.mkdir(path.join(dir, 'a'), { recursive: true });
      await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
      await fs.writeFile(path.join(dir, 'a', 'b.ts'), 'export {};\n');
      await fs.writeFile(path.join(dir, 'node_modules', 'x.ts'), 'export {};\n');
      const found = await shimWs.findFiles(new ShimRP(ShimUri.file(dir), '**/*.ts'), new ShimRP(ShimUri.file(dir), '{**/node_modules/**}'));
      assert.deepStrictEqual(found.map((u) => u.fsPath), [path.join(dir, 'a', 'b.ts')]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('globToRegExp treats an unclosed brace literally and expands ** inside braces', () => {
    assert.ok(globToRegExp('src/**/*.{ts,tsx').test('src/a/b.{ts,tsx'));
    const alt = globToRegExp('{**/dist/**,**/*.min.js}');
    assert.ok(alt.test('a/b/dist/x.js'));
    assert.ok(alt.test('a/b/c.min.js'));
    assert.ok(globToRegExp('**/*.{ts,tsx}').test('a/b/c.tsx'));
  });
});

suite('Shell invocation', () => {
  test('the agent terminal changes directory in the syntax of its shell and compares Windows paths loosely', () => {
    assert.ok(samePath('c:\\Users\\x\\wt', 'C:\\Users\\x\\wt', 'win32'));
    assert.ok(samePath('/a/b/', '/a/b', 'linux'));
    assert.ok(!samePath('/a/B', '/a/b', 'linux'));
    assert.ok(!samePath(undefined, '/a', 'linux'));
    const ps = inDir("C:\\it's\\wt", 'npm test', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32');
    assert.ok(!ps.includes('&&'), ps);
    assert.ok(ps.startsWith('Set-Location -LiteralPath '), ps);
    assert.ok(ps.includes("it''s"), ps);
    assert.ok(inDir('C:\\wt', 'npm test', undefined, 'win32').startsWith('Set-Location'));
    assert.strictEqual(inDir('C:\\wt', 'npm test', 'cmd.exe', 'win32'), 'cd /d "C:\\wt" && npm test');
    assert.strictEqual(inDir("/tmp/it's", 'ls', '/bin/zsh', 'darwin'), "cd '/tmp/it'\\''s' && ls");
  });

  test('child-process shells keep cmd.exe quotes intact and fall back to an existing POSIX shell', () => {
    const win = shellInvocation('git commit -m "a b"', { platform: 'win32', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } });
    assert.strictEqual(win.file, 'C:\\Windows\\system32\\cmd.exe');
    assert.deepStrictEqual(win.args, ['/d', '/s', '/c', '"git commit -m "a b""']);
    assert.strictEqual(win.windowsVerbatimArguments, true);
    assert.strictEqual(shellInvocation('ls', { platform: 'linux', env: {}, exists: (p) => p === '/bin/sh' }).file, '/bin/sh');
    const zsh = shellInvocation('ls', { platform: 'linux', env: { SHELL: '/bin/zsh' }, exists: (p) => p === '/bin/bash', login: true });
    assert.strictEqual(zsh.file, '/bin/bash');
    assert.deepStrictEqual(zsh.args, ['-lc', 'ls']);
  });

  test('run_command without the integrated terminal runs quoted arguments through the shell', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    this.timeout(30_000);
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prev = cfg.inspect<boolean>('terminal.runInIntegratedTerminal')?.globalValue;
    await cfg.update('terminal.runInIntegratedTerminal', false, vscode.ConfigurationTarget.Global);
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lp-shell-')));
    try {
      const ctx: ToolContext = { sessionId: 't', workspaceRoot: dir, signal: new AbortController().signal, depth: 0, progress: () => undefined, trackChange: async () => undefined, requestApproval: async () => true };
      const r = await runCommandTool.execute({ command: `"${process.execPath}" -e "console.log('a b')"` }, ctx);
      assert.ok(r.content.includes('a b'), r.content);
      assert.ok(!r.isError, r.content);
    } finally {
      await cfg.update('terminal.runInIntegratedTerminal', prev, vscode.ConfigurationTarget.Global);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
