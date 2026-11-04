#!/usr/bin/env node
// End-to-end test of the `localpilot` CLI with local and cloud providers: runs the bundled dist/cli.js the way a user
// does, in a throwaway HOME, against mock servers for Anthropic (Claude), an OmniRoute-style gateway and a local
// OpenAI-compatible server. Covers `providers presets|add|key|test|remove`, `models`, `doctor`, a full agent run on
// Claude (tool call → result → answer) and Auto routing staying local.
// Run: npm run e2e:cli   (builds first)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const CLI = path.resolve('dist/cli.js');
if (!fs.existsSync(CLI)) {
  console.error('dist/cli.js missing — run `node esbuild.js` first');
  process.exit(1);
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cli-e2e-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cli-ws-'));
fs.writeFileSync(path.join(ws, 'hello.txt'), 'The secret word is pineapple.\n');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? '✔' : '✖'} ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) {
      console.log(`      ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1500).replace(/\n/g, '\n      ')}`);
    }
  }
};

// ------------------------------------------------------------------ mock servers
const seen = { claudeKeys: [], claudeBodies: [], localChats: 0, omniChats: 0, localBodies: [], localAuth: [] };
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b)); });
const srv = http.createServer(async (req, res) => {
  const url = req.url ?? '';
  if (url.startsWith('/anthropic/')) {
    seen.claudeKeys.push(req.headers['x-api-key']);
    if (req.headers['x-api-key'] !== 'sk-e2e-claude') {
      res.statusCode = 401;
      return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    }
    if (url.startsWith('/anthropic/v1/models')) {
      return res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', max_input_tokens: 1000000, max_tokens: 64000 }], has_more: false }));
    }
    const b = JSON.parse(await body(req));
    seen.claudeBodies.push(b);
    const result = JSON.stringify(b.messages).match(/The secret word is (\w+)/);
    res.setHeader('content-type', 'text/event-stream');
    const ev = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    ev({ type: 'message_start', message: { usage: { input_tokens: 50 } } });
    if (!result) {
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_e2e', name: 'read_file', input: {} } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"hello.txt"}' } });
      ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } });
    } else {
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `Claude read it: the word is ${result[1]}.` } });
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } });
    }
    ev({ type: 'message_stop' });
    return res.end();
  }
  const omni = url.startsWith('/omni/');
  if (url.endsWith('/v1/models')) {
    return res.end(JSON.stringify({ data: omni ? [{ id: 'auto/coding' }, { id: 'cc/claude-sonnet-4-6' }] : [{ id: 'qwen2.5-coder-7b', capabilities: ['tool_use'] }] }));
  }
  if (url.endsWith('/v1/chat/completions')) {
    const b = JSON.parse(await body(req));
    omni ? seen.omniChats++ : (seen.localChats++, seen.localBodies.push(b), seen.localAuth.push(req.headers.authorization));
    res.setHeader('content-type', 'text/event-stream');
    // Headless checks: E2E_SLOW answers too late for --timeout; E2E_FAILTOOL keeps calling a tool that fails.
    const asked = JSON.stringify(b.messages.filter((m) => m.role === 'user').slice(0, 1));
    if (asked.includes('E2E_SLOW')) {
      await new Promise((r) => setTimeout(r, 6000));
    }
    if (asked.includes('E2E_FAILTOOL')) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${seen.localChats}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"no-such-file.txt"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${omni ? 'Gateway' : 'Local'} model ${b.model} answered.` }, finish_reason: 'stop' }] })}\n\n`);
    return res.end('data: [DONE]\n\n');
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

// A provider defined in VS Code's settings, whose key VS Code keeps in the keychain (`${secret:vsc}`).
const vsSettings = process.platform === 'darwin'
  ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
  : process.platform === 'win32' ? path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'settings.json') : path.join(home, '.config', 'Code', 'User', 'settings.json');
fs.mkdirSync(path.dirname(vsSettings), { recursive: true });
fs.writeFileSync(vsSettings, JSON.stringify({ 'localpilot.providers': [{ id: 'vsc', type: 'openai', baseUrl: `${base}/local/v1`, displayName: 'From VS Code' }, { id: 'vslm', type: 'vscode-lm', baseUrl: 'vscode://lm' }], 'localpilot.telemetry.enabled': false, 'localpilot.skills.autoInstall': 'off', 'localpilot.autoClarify': false }, null, 2));

/** Runs the CLI with a fresh environment (no real keys leak in) and returns its exit code and output. */
function cli(args, { input, env = {}, cwd = ws } = {}) {
  return new Promise((resolve) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/API_KEY|_TOKEN$|^LOCALPILOT_KEY_/.test(k)));
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...clean, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: path.join(home, '.config'), NO_COLOR: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => ((out += d), (stdout += d)));
    child.stderr.on('data', (d) => ((out += d), (stderr += d)));
    child.stdin.end(input ?? '');
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out, stdout, stderr });
    });
  });
}
const cfgFile = path.join(home, '.localpilot', 'config.json');
const keysFile = path.join(home, '.localpilot', 'keys.json');
const readCfg = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8'));

try {
  console.log('[localpilot providers]');
  let r = await cli(['providers', 'presets']);
  check('presets list local, cloud and gateway providers', r.code === 0 && /anthropic/.test(r.out) && /openrouter/.test(r.out) && /omniroute/.test(r.out) && /ollama/.test(r.out), r.out);

  r = await cli(['providers', 'add', 'anthropic', '--url', `${base}/anthropic/v1`, '--key', 'sk-e2e-claude']);
  check('add anthropic with a key: connected, models listed', r.code === 0 && /Connected/.test(r.out) && /anthropic\/claude-sonnet-4-6/.test(r.out), r.out);
  const cfg = readCfg();
  const claude = cfg.providers.find((p) => p.id === 'anthropic');
  check('settings hold a ${secret:anthropic} reference, never the key', claude?.apiKey === '${secret:anthropic}' && !fs.readFileSync(cfgFile, 'utf8').includes('sk-e2e-claude'), cfg);
  const mode = fs.statSync(keysFile).mode & 0o777;
  check('key stored in keys.json, readable by the owner only', JSON.parse(fs.readFileSync(keysFile, 'utf8')).anthropic === 'sk-e2e-claude' && (process.platform === 'win32' || mode === 0o600), mode.toString(8));

  r = await cli(['providers', 'add', 'omniroute', '--url', `${base}/omni/v1`]);
  check('add the OmniRoute gateway: marked cloud, models listed', r.code === 0 && readCfg().providers.find((p) => p.id === 'omniroute')?.cloud === true && /omniroute\/auto\/coding/.test(r.out), r.out);

  r = await cli(['providers', 'add', `${base}/local/v1`, '--id', 'local', '--name', 'Local server']);
  check('add a custom local URL', r.code === 0 && /Connected/.test(r.out), r.out);

  r = await cli(['providers', 'add', 'openai', '--key-env', 'MY_OPENAI']);
  check('add openai reading its key from an environment variable', readCfg().providers.find((p) => p.id === 'openai')?.apiKey === '${env:MY_OPENAI}', r.out);

  r = await cli(['providers']);
  const localPart = r.out.split('Cloud')[0];
  const cloudPart = r.out.split('Cloud')[1] ?? '';
  check('list: local and VS Code providers under Local, Claude and the gateway under Cloud', /local\b/.test(localPart) && /vsc\b/.test(localPart) && /anthropic/.test(cloudPart) && /omniroute/.test(cloudPart), r.out);
  check('list: key state shown, the key itself never printed', /key stored/.test(r.out) && /MY_OPENAI not set/.test(r.out) && !r.out.includes('sk-e2e-claude'), r.out);

  r = await cli(['providers', 'key', 'vsc'], { input: 'sk-piped-for-vsc\n' });
  check('key for a VS Code provider, piped in: stored for the CLI', r.code === 0 && JSON.parse(fs.readFileSync(keysFile, 'utf8')).vsc === 'sk-piped-for-vsc' && readCfg().providers.find((p) => p.id === 'vsc')?.apiKey === '${secret:vsc}', r.out);
  check('the VS Code provider keeps its URL from VS Code (merged by id)', readCfg().providers.find((p) => p.id === 'vsc')?.baseUrl === undefined && /From VS Code/.test((await cli(['providers'])).out));

  console.log('[localpilot models / doctor]');
  r = await cli(['models']);
  check('models: Claude and gateway models marked cloud, local ones not', /anthropic\/claude-sonnet-4-6\s+\S+\s+cloud/.test(r.out) && /omniroute\/auto\/coding\s+\S+\s+cloud/.test(r.out) && !/local\/qwen2.5-coder-7b\s+\S+\s+cloud/.test(r.out), r.out);
  r = await cli(['doctor']);
  check('doctor lists providers with key state', /Providers/.test(r.out) && /anthropic/.test(r.out) && /key stored/.test(r.out), r.out);

  console.log('[agent runs]');
  r = await cli(['-y', '-p', '--no-mcp', '-m', 'anthropic/claude-sonnet-4-6', 'What does hello.txt say?']);
  check('Claude run: read_file tool executed and the answer uses its result', r.code === 0 && /the word is pineapple/.test(r.out), r.out);
  check('Claude run: stored key sent, no temperature, tools sent', seen.claudeBodies.length >= 2 && seen.claudeKeys.includes('sk-e2e-claude') && seen.claudeBodies.every((b) => !('temperature' in b) && Array.isArray(b.tools)), seen.claudeBodies.length);

  const before = { local: seen.localChats, omni: seen.omniChats, claude: seen.claudeBodies.length };
  r = await cli(['-y', '-p', '--no-mcp', 'Say hi']);
  check('Auto (no model chosen): a local model answers, not Claude or the gateway', r.code === 0 && /Local model/.test(r.out) && seen.localChats > before.local && seen.omniChats === before.omni && seen.claudeBodies.length === before.claude, r.out);

  r = await cli(['-y', '-p', '--no-mcp', '-m', 'omniroute/auto/coding', 'Say hi']);
  check('gateway model chosen explicitly answers through OmniRoute', /Gateway model auto\/coding answered/.test(r.out), r.out);

  console.log('[saved sessions]');
  r = await cli(['-y', '-p', '--no-mcp', '-m', 'local/qwen2.5-coder-7b', 'Remember the codeword mango']);
  const firstRun = r;
  r = await cli(['-y', '-p', '--no-mcp', '-m', 'local/qwen2.5-coder-7b', '-c', 'What was the codeword?']);
  const resent = JSON.stringify(seen.localBodies.at(-1)?.messages ?? []);
  check('-c continues the last session: the earlier turn goes to the model again', firstRun.code === 0 && r.code === 0 && resent.includes('mango') && resent.includes('What was the codeword?'), resent.slice(0, 600));
  const sessionsDir = path.join(home, '.localpilot', 'workspaces');
  const saved = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).flatMap((h) => fs.readdirSync(path.join(sessionsDir, h, 'sessions')).filter((f) => f.endsWith('.json'))) : [];
  check('sessions are saved under ~/.localpilot/workspaces/<hash>/sessions', saved.length >= 1, saved);
  r = await cli(['history', '--json']);
  const hist = JSON.parse(r.out.slice(r.out.indexOf('[')));
  check('history --json: newest first, tagged cli, with both turns', r.code === 0 && hist[0]?.origin === 'cli' && hist[0].messages >= 4 && /mango/i.test(hist[0].title), hist[0]);
  r = await cli(['history', 'export', hist[0].id, '-o', 'chat.html']);
  const html = fs.existsSync(path.join(ws, 'chat.html')) ? fs.readFileSync(path.join(ws, 'chat.html'), 'utf8') : '';
  check('history export -o file.html writes a standalone page', r.code === 0 && html.startsWith('<!DOCTYPE html>') && html.includes('<pre>') && html.includes('mango') && !/<script/i.test(html), r.out);
  r = await cli(['-y', '-p', '--no-mcp', '-m', 'local/qwen2.5-coder-7b', '-r', hist[0].id, 'And again?']);
  check('-r <id> resumes that session', r.code === 0 && JSON.stringify(seen.localBodies.at(-1)?.messages ?? []).includes('mango'), r.out);
  r = await cli(['-p', '--no-mcp', '-r', 'cli-doesnotexist', 'x']);
  check('-r with an unknown id: exit code 2', r.code === 2 && /no saved session/.test(r.out), r.out);
  r = await cli(['history', 'delete', hist[0].id]);
  check('history delete removes the session', r.code === 0 && !JSON.parse((await cli(['history', '--json'])).out.replace(/^[^[]*/, '')).some((s) => s.id === hist[0].id), r.out);

  console.log('[isolated sessions]');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cli-repo-'));
  const git = (...a) => new Promise((res) => spawn('git', ['-C', repo, ...a], { stdio: 'ignore' }).on('exit', res).on('error', () => res(-1)));
  if ((await git('init', '-q')) === 0) {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    await git('add', '-A');
    await git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-qm', 'init');
    const repoSessions = () => {
      const dir = path.join(home, '.localpilot', 'workspaces');
      return fs.readdirSync(dir).flatMap((h) => {
        const d = path.join(dir, h, 'sessions');
        return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => path.join(d, f)) : [];
      }).map((f) => ({ f, s: JSON.parse(fs.readFileSync(f, 'utf8')) })).filter((x) => JSON.stringify(x.s).includes('isolated codeword'));
    };
    const iso = await cli(['-y', '-p', '--no-mcp', '-m', 'local/qwen2.5-coder-7b', '--isolate', 'Remember the isolated codeword kiwi'], { cwd: repo });
    const afterIso = repoSessions();
    check('--isolate run: the saved session no longer names the removed worktree', iso.code === 0 && afterIso.length === 1 && !afterIso[0].s.worktree, iso.out);
    // A session saved by an older build still pointing at a worktree that is gone: -c works in the checkout again.
    if (afterIso[0]) {
      fs.writeFileSync(afterIso[0].f, JSON.stringify({ ...afterIso[0].s, worktree: { path: path.join(repo, 'gone-worktree'), repo, base: 'HEAD', createdAt: Date.now(), owner: 'cli' } }));
    }
    r = await cli(['-y', '-p', '--no-mcp', '-m', 'local/qwen2.5-coder-7b', '-c', 'What was the isolated codeword?'], { cwd: repo });
    const afterResume = repoSessions();
    check('-c after --isolate: continues in the checkout and drops the stale worktree', r.code === 0 && /Local model/.test(r.out) && afterResume.length === 1 && !afterResume[0].s.worktree && JSON.stringify(seen.localBodies.at(-1)?.messages ?? []).includes('kiwi'), r.out);
  } else {
    console.log('  - git not available; skipped');
  }
  fs.rmSync(repo, { recursive: true, force: true });

  console.log('[headless runs]');
  const local = ['--no-mcp', '-m', 'local/qwen2.5-coder-7b'];
  r = await cli(['-y', ...local, '--json', 'Say hi']);
  const lines = r.stdout.split('\n').filter(Boolean);
  const records = lines.map((l) => { try { return JSON.parse(l); } catch { return undefined; } });
  check('--json: every stdout line is a JSON event, ending with run_result', r.code === 0 && records.length > 1 && records.every((x) => x && typeof x.type === 'string' && typeof x.ts === 'number') && records.at(-1).type === 'run_result' && records.at(-1).finishReason === 'completed' && /Local model/.test(records.at(-1).text) && records.some((x) => x.type === 'assistant_delta'), r.out);
  r = await cli(['-y', ...local, 'Review the piped text'], { input: 'piped-line-42\n' });
  check('piped stdin plus a prompt: sent as <stdin> context, answer only on a non-TTY stdout', r.code === 0 && JSON.stringify(seen.localBodies.at(-1)?.messages ?? []).includes('<stdin>\\npiped-line-42') && r.stdout.trim().startsWith('Local model'), r.out);
  r = await cli(['-y', ...local, '--timeout', '2', 'E2E_SLOW answer late']);
  check('--timeout: the run stops and exits with 124', r.code === 124 && /timed out/.test(r.stderr), r.out);
  r = await cli(['-y', ...local, '--retries', '2', 'E2E_FAILTOOL read it']);
  check('--retries 2: two failed steps in a row stop the run with exit code 3', r.code === 3 && /2 errors in a row/.test(r.out), r.out);
  r = await cli(['--yolo', '-m', 'local/qwen2.5-coder-7b', '--json', 'E2E_FAILTOOL again']);
  // The run's own requests (an automatic memory save after it sends no tools).
  const yoloTools = (seen.localBodies.filter((b) => Array.isArray(b.tools) && JSON.stringify(b.messages).includes('E2E_FAILTOOL again')).at(-1)?.tools ?? []).map((t) => t.function?.name).sort();
  const errLine = r.stderr.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).find((x) => x?.type === 'error');
  check('--yolo: core tools only, mistake limit 3 (exit 3), error as JSON on stderr', r.code === 3 && yoloTools.length > 0 && yoloTools.every((n) => ['read_file', 'edit_file', 'apply_patch', 'write_file', 'run_command', 'grep_search', 'file_search', 'list_dir'].includes(n)) && errLine?.kind === 'mistake_limit' && errLine.count === 3, { code: r.code, yoloTools, stderr: r.stderr.slice(0, 400) });
  // A home whose only provider is not listening: the run fails before it starts, still as JSON on stderr.
  const deadHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cli-dead-'));
  const deadSettings = vsSettings.replace(home, deadHome);
  fs.mkdirSync(path.dirname(deadSettings), { recursive: true });
  fs.writeFileSync(deadSettings, JSON.stringify({ 'localpilot.providers': [{ id: 'dead', type: 'openai', baseUrl: 'http://127.0.0.1:9/v1' }], 'localpilot.telemetry.enabled': false }));
  const jsonErrs = [];
  for (const args of [['--json', '--no-mcp', '-m', 'dead/x', 'Say hi'], ['--json', '-k', 'sk-x', 'Say hi'], ['--json', '-P', 'no-such-provider', 'Say hi']]) {
    const d = await cli(args, { env: { HOME: deadHome, USERPROFILE: deadHome, APPDATA: path.join(deadHome, 'AppData', 'Roaming'), XDG_CONFIG_HOME: path.join(deadHome, '.config') } });
    const errLines = d.stderr.split('\n').filter(Boolean);
    const parsed = errLines.map((l) => { try { return JSON.parse(l); } catch { return undefined; } });
    jsonErrs.push({ args: args.join(' '), code: d.code, ok: d.code === 2 && errLines.length > 0 && parsed.every((x) => x && typeof x.type === 'string') && parsed.some((x) => x.type === 'error' && typeof x.message === 'string' && x.kind), stderr: d.stderr.slice(0, 300) });
  }
  fs.rmSync(deadHome, { recursive: true, force: true });
  check('--json: failures before the run (unreachable provider, -k without -P, unknown -P) are JSON error lines on stderr, exit 2', jsonErrs.every((x) => x.ok), jsonErrs);
  r = await cli(['-y', '--no-mcp', '-P', 'local', '-k', 'sk-run-only', '-p', 'Say hi']);
  check('-P/-k: the key is used for this run and not saved', r.code === 0 && seen.localAuth.at(-1) === 'Bearer sk-run-only' && !fs.readFileSync(cfgFile, 'utf8').includes('sk-run-only') && !(fs.existsSync(keysFile) && fs.readFileSync(keysFile, 'utf8').includes('sk-run-only')), r.out);
  r = await cli(['-y', ...local, '-s', 'E2E-SYSTEM-APPEND', '-p', 'Say hi']);
  check('-s appends to the system prompt', r.code === 0 && String(seen.localBodies.at(-1)?.messages?.[0]?.content ?? '').includes('E2E-SYSTEM-APPEND'), r.out);
  r = await cli(['config', 'tools', '--json']);
  const tools = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
  check('config tools --json: tools with their approval kind', r.code === 0 && tools.some((t) => t.name === 'run_command' && t.approval === 'terminal') && tools.some((t) => t.name === 'read_file' && t.approval === 'none'), r.out.slice(0, 600));
  r = await cli(['config', 'nope']);
  check('config with an unknown kind: exit code 2', r.code === 2, r.out);
  r = await cli(['doctor', '--json']);
  const doc = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  check('doctor --json: providers with key state, never the key', r.code === 0 && Array.isArray(doc.providers) && doc.providers.some((p) => p.id === 'local' && p.reachable) && !r.stdout.includes('sk-e2e-claude') && typeof doc.log === 'string', r.out.slice(0, 600));
  check('doctor --json: the VS Code-only vscode-lm provider is hidden', !doc.providers.some((p) => p.type === 'vscode-lm'), doc.providers);

  console.log('[keys]');
  r = await cli(['providers', 'key', 'anthropic', '--remove-key']);
  const after = await cli(['providers']);
  check('remove-key: key deleted and the provider reports it', r.code === 0 && !('anthropic' in JSON.parse(fs.readFileSync(keysFile, 'utf8'))) && /no API key/.test(after.out), after.out);
  r = await cli(['providers', 'key', 'anthropic', 'sk-e2e-claude']);
  check('key given as an argument: saved and connection checked', r.code === 0 && /Connected/.test(r.out), r.out);
  const envOnly = await cli(['providers', 'test', 'vsc'], { env: { LOCALPILOT_KEY_VSC: 'from-env' } });
  check('test one provider', envOnly.code === 0 && /Connected/.test(envOnly.out), envOnly.out);

  console.log('[remove]');
  r = await cli(['providers', 'remove', 'omniroute']);
  check('remove a CLI-added provider', r.code === 0 && !readCfg().providers.some((p) => p.id === 'omniroute'), r.out);
  r = await cli(['providers', 'remove', 'vsc']);
  check('remove a VS Code provider: disabled for the CLI only', r.code === 0 && readCfg().providers.find((p) => p.id === 'vsc')?.enabled === false && fs.readFileSync(vsSettings, 'utf8').includes('"vsc"'), r.out);
  r = await cli(['providers', 'add', 'nope-not-a-provider']);
  check('unknown preset: clear error, exit code 2', r.code === 2 && /Unknown provider/.test(r.out), r.out);
} finally {
  srv.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} CLI check(s) FAILED` : '\nAll CLI end-to-end checks passed');
process.exit(failures ? 1 : 0);
