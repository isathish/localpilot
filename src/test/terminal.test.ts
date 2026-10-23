import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TerminalManager } from '../terminal/terminalManager';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
    if (!r) {
      // Shell integration never attached in this environment (headless CI shells) — the tool falls back to a child process.
      this.skip();
    }
    assert.match(r.output, /lp-marker-42/);
    assert.strictEqual(r.exitCode, 0);
    const fail = await tm.run('test-session', '(exit 3)', EXT_ROOT, new AbortController().signal, 20_000, false);
    assert.strictEqual(fail?.exitCode, 3);
    // The agent terminal is reused per session and branded.
    const agentTerms = vscode.window.terminals.filter((t) => t.name === 'LocalPilot Agent');
    assert.strictEqual(agentTerms.length, 1);
    assert.ok(tm.recordCount >= 2, 'executions are recorded for @terminal');
    assert.strictEqual(tm.lastFailure()?.exitCode, 3);
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
        return res.end(JSON.stringify({ data: [{ id: 'mock-coder', object: 'model' }] }));
      }
      if (req.url === '/v1/chat/completions') {
        const stream = /"stream"\s*:\s*true/.test(body);
        if (stream) {
          res.setHeader('content-type', 'text/event-stream');
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply }, index: 0 }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] })}\n\n`);
          return res.end('data: [DONE]\n\n');
        }
        return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] }));
      }
      res.statusCode = 404;
      res.end();
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: () => srv.close(), requests })));
}

suite('LocalPilot CLI (dist/cli.js)', () => {
  const cli = path.join(EXT_ROOT, 'dist', 'cli.js');
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
    await fs.writeFile(path.join(home, '.localpilot', 'config.json'), JSON.stringify({ providers: [{ id: 'dead', type: 'openai', baseUrl: 'http://127.0.0.1:9/v1' }] }));
    const r = await run(['--no-mcp', '-p', 'hello']);
    assert.strictEqual(r.code, 2);
    assert.match(r.err, /No local models found|unreachable|doctor/i);
  });

  test('models / doctor / a real one-shot run against an OpenAI-compatible server, reading providers from ~/.localpilot/config.json', async function () {
    this.timeout(60_000);
    const srv = await mockOpenAI('The answer is **42**.');
    try {
      await fs.writeFile(path.join(home, '.localpilot', 'config.json'), JSON.stringify({ providers: [{ id: 'mock', type: 'openai', baseUrl: srv.url, displayName: 'Mock' }], defaultModel: 'mock/mock-coder' }));
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
});
