import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * End-to-end run of the agent loop through the CLI (dist/cli.js) against a scripted OpenAI-compatible mock, with a
 * Claude Code `settings.json` in the working folder: permission rules deny one command and allow another, a
 * PreToolUse hook sees the call, a UserPromptSubmit hook adds context, a Stop hook sends the agent back once, and a
 * custom slash command runs with its own allowed-tools. Deterministic: the "model" answers by request number.
 */

const EXT_ROOT = vscode.extensions.getExtension('localpilot.localpilot-agent')!.extensionPath;
const posix = process.platform !== 'win32';

interface Step {
  /** Assertion on the request's messages before answering. */
  check?: (messages: { role: string; content?: string; tool_call_id?: string }[]) => void;
  text?: string;
  toolCall?: { name: string; args: Record<string, unknown> };
}

function scriptedOpenAI(steps: Step[]): Promise<{ url: string; close(): void; requests: { role: string; content?: string }[][]; errors: string[] }> {
  const requests: { role: string; content?: string }[][] = [];
  const errors: string[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'scripted', object: 'model' }] }));
        return;
      }
      if (req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      const parsed = JSON.parse(body) as { messages: { role: string; content?: string }[] };
      requests.push(parsed.messages);
      const step = steps[requests.length - 1] ?? { text: `(unscripted request ${requests.length})` };
      try {
        step.check?.(parsed.messages);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
      res.setHeader('content-type', 'text/event-stream');
      if (step.toolCall) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: step.toolCall.name, arguments: JSON.stringify(step.toolCall.args) } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: step.text ?? '' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: () => srv.close(), requests, errors })));
}

suite('Claude Code compatibility: agent loop end-to-end (CLI + scripted model)', () => {
  const cli = path.join(EXT_ROOT, 'dist', 'cli.js');
  let home: string;
  let ws: string;

  const run = (args: string[], opts: { input?: string } = {}) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = cp.spawn(process.execPath, [cli, ...args], { cwd: ws, env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1', XDG_CONFIG_HOME: path.join(home, '.config') } });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.stdin.end(opts.input ?? '');
      child.on('close', (code) => resolve({ code, out, err }));
    });

  suiteSetup(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-cc-home-'));
    ws = path.join(home, 'ws');
    await fs.mkdir(path.join(home, 'Library', 'Application Support', 'Code', 'User'), { recursive: true });
    await fs.mkdir(path.join(home, '.config', 'Code', 'User'), { recursive: true });
    await fs.mkdir(path.join(ws, '.localpilot'), { recursive: true });
  });
  suiteTeardown(() => fs.rm(home, { recursive: true, force: true }));

  (posix ? test : test.skip)('permission rules, PreToolUse / UserPromptSubmit / Stop hooks and CLAUDE.md all apply to a real run', async function () {
    this.timeout(90_000);
    await fs.writeFile(
      path.join(ws, '.localpilot', 'settings.json'),
      JSON.stringify({
        permissions: { deny: ['Bash(rm:*)'], allow: ['Bash(echo:*)'] },
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo CTX-FROM-HOOK' }] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'cat > "$CLAUDE_PROJECT_DIR/pre.json"' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'if [ ! -f "$CLAUDE_PROJECT_DIR/stop.flag" ]; then touch "$CLAUDE_PROJECT_DIR/stop.flag"; echo "write done.txt first" >&2; exit 2; fi' }] }],
        },
      })
    );
    await fs.writeFile(path.join(ws, 'CLAUDE.md'), 'PROJECT-RULE-MARKER\n@docs/extra.md');
    await fs.mkdir(path.join(ws, 'docs'), { recursive: true });
    await fs.writeFile(path.join(ws, 'docs', 'extra.md'), 'IMPORTED-RULE-MARKER');
    const last = (m: { role: string; content?: string }[]) => m[m.length - 1];
    const srv = await scriptedOpenAI([
      {
        check: (m) => {
          assert.ok(m[0].role === 'system' && m[0].content?.includes('PROJECT-RULE-MARKER'), 'CLAUDE.md is in the system prompt');
          assert.ok(m[0].content?.includes('IMPORTED-RULE-MARKER'), '@import resolved into the system prompt');
          assert.ok(m.some((x) => x.role === 'user' && x.content?.includes('CTX-FROM-HOOK')), 'UserPromptSubmit stdout became context');
        },
        toolCall: { name: 'run_command', args: { command: 'rm -rf build' } },
      },
      {
        check: (m) => {
          assert.strictEqual(last(m).role, 'tool');
          assert.match(last(m).content ?? '', /Blocked by permission rule `Bash\(rm:\*\)`/);
        },
        toolCall: { name: 'run_command', args: { command: 'echo hook-sees-me' } },
      },
      {
        check: (m) => {
          assert.strictEqual(last(m).role, 'tool');
          assert.match(last(m).content ?? '', /hook-sees-me/, 'the allowed command ran without a prompt');
        },
        text: 'all done',
      },
      {
        check: (m) => {
          assert.strictEqual(last(m).role, 'user');
          assert.match(last(m).content ?? '', /Stop hook blocked finishing: write done.txt first/);
        },
        text: 'finished after hook',
      },
    ]);
    try {
      await fs.mkdir(path.join(home, '.localpilot'), { recursive: true });
      await fs.writeFile(path.join(home, '.localpilot', 'config.json'), JSON.stringify({ providers: [{ id: 'mock', type: 'openai', baseUrl: srv.url, displayName: 'Mock' }], defaultModel: 'mock/scripted' }));
      // No --yes: the allowed `echo` must run without approval purely because of the allow rule (stdin is not a TTY, so a prompt would deny).
      const r = await run(['--print', '--no-mcp', 'clean the build folder']);
      assert.strictEqual(r.code, 0, r.err);
      assert.deepStrictEqual(srv.errors, [], srv.errors.join('\n'));
      assert.strictEqual(srv.requests.length, 4, `expected 4 model requests, got ${srv.requests.length}`);
      assert.strictEqual(r.out.trim(), 'finished after hook');
      const pre = JSON.parse(await fs.readFile(path.join(ws, 'pre.json'), 'utf8')) as { hook_event_name: string; tool_name: string; tool_input: { command: string }; cwd: string; session_id: string };
      assert.strictEqual(pre.hook_event_name, 'PreToolUse');
      assert.strictEqual(pre.tool_name, 'Bash', 'hooks see Claude Code tool names');
      assert.strictEqual(pre.tool_input.command, 'echo hook-sees-me');
      assert.ok(pre.session_id);
      assert.ok(await fs.stat(path.join(ws, 'stop.flag')).catch(() => undefined), 'the Stop hook ran');
    } finally {
      srv.close();
    }
  });

  (posix ? test : test.skip)('a custom slash command expands its prompt and runs with its own allowed-tools', async function () {
    this.timeout(90_000);
    await fs.writeFile(path.join(ws, '.localpilot', 'settings.json'), '{}');
    await fs.mkdir(path.join(ws, '.claude', 'commands'), { recursive: true });
    await fs.writeFile(path.join(ws, '.claude', 'commands', 'ship.md'), '---\ndescription: Ship it\nargument-hint: [version]\nallowed-tools: Bash(git tag:*), Bash(echo:*)\n---\nTag version $1. Current tags: !`echo v0.9`\nThen confirm.');
    const srv = await scriptedOpenAI([
      {
        check: (m) => {
          const user = m.filter((x) => x.role === 'user').pop();
          assert.match(user?.content ?? '', /Tag version 1\.2\.3\./, '$1 substituted');
          assert.match(user?.content ?? '', /\$ echo v0\.9\nv0\.9/, '!`cmd` inlined');
        },
        toolCall: { name: 'run_command', args: { command: 'echo tagged' } },
      },
      {
        check: (m) => assert.match(m[m.length - 1].content ?? '', /tagged/, 'allowed-tools of the command permitted echo without a prompt'),
        text: 'shipped',
      },
    ]);
    try {
      await fs.writeFile(path.join(home, '.localpilot', 'config.json'), JSON.stringify({ providers: [{ id: 'mock', type: 'openai', baseUrl: srv.url, displayName: 'Mock' }], defaultModel: 'mock/scripted' }));
      // One-shot: `/ship 1.2.3` expands the custom command before it reaches the model.
      const r = await run(['--print', '--no-mcp', '/ship 1.2.3']);
      assert.strictEqual(r.code, 0, r.err);
      assert.deepStrictEqual(srv.errors, [], srv.errors.join('\n'));
      assert.strictEqual(r.out.trim(), 'shipped');
    } finally {
      srv.close();
    }
  });
});
