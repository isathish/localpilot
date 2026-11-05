#!/usr/bin/env node
// End-to-end test of the `localpilot` CLI with local and cloud providers: runs the bundled dist/cli.js the way a user
// does, in a throwaway HOME, against mock servers for Anthropic (Claude), an OmniRoute-style gateway and a local
// OpenAI-compatible server. Covers `providers presets|add|key|test|remove`, `models`, `doctor`, a full agent run on
// Claude (tool call → result → answer) and Auto routing staying local. Self-healing: outcome exit codes (0/1/4/5), the
// NDJSON outcome and contract, recovery events, checks.json trust, `recovery list|show|resume|clear`, `-c` on an interrupted
// recovery and model retries, against a scripted model that edits files in throwaway workspaces with real `npm test` checks.
// Run: npm run e2e:cli   (builds first)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * Removes a temp folder. On Windows a process that just exited (the cmd.exe/npm wrappers of a killed check, an
 * antivirus scan) can hold it for a moment (EBUSY/EPERM): retried, then only warned about, since a leftover temp
 * folder is not a test failure.
 */
function removeTemp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (e) {
    console.warn(`  (could not remove ${dir}: ${e.code ?? e.message})`);
  }
}


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

// Self-healing: a scripted model in its own home. Each request's mode comes from the newest user message with a
// HEAL_MODE=<mode> / HEAL_TALK marker: after a user turn (or a hidden fix prompt) it writes a file, after a tool result it
// answers with a root cause. `down` answers the next agent requests with 503s, `alwaysDown` every request.
const heal = { chats: 0, writes: 0, writeTimes: [], down: 0, alwaysDown: false };
const healSrv = http.createServer(async (req, res) => {
  const url = req.url ?? '';
  if (url.endsWith('/v1/models')) {
    return res.end(JSON.stringify({ data: [{ id: 'coder', capabilities: ['tool_use'] }] }));
  }
  if (!url.endsWith('/v1/chat/completions')) {
    res.statusCode = 404;
    return res.end();
  }
  const b = JSON.parse(await body(req));
  heal.chats++;
  const agentCall = Array.isArray(b.tools) && b.tools.length > 0;
  if (heal.alwaysDown || (agentCall && heal.down > 0)) {
    heal.down = Math.max(0, heal.down - 1);
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: { message: 'service unavailable' } }));
  }
  res.setHeader('content-type', 'text/event-stream');
  const say = (text) => {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  };
  const marked = b.messages.filter((m) => m.role === 'user' && /HEAL_MODE=\w+|HEAL_TALK/.test(JSON.stringify(m.content))).at(-1);
  const mode = /HEAL_MODE=(\w+)/.exec(JSON.stringify(marked?.content ?? ''))?.[1];
  if (!agentCall || !mode) {
    return say('Hi from the healing model.');
  }
  if (b.messages.at(-1)?.role === 'tool') {
    return say('Root cause: add() multiplied its arguments instead of adding them\nFiles changed: math.js\nDone: yes');
  }
  const n = ++heal.writes;
  heal.writeTimes.push(Date.now());
  const file = mode === 'app' ? 'app.js' : 'math.js';
  const content = mode === 'bad' ? `module.exports.add = (a, b) => a * b + ${n}; // attempt ${n}\n` : mode === 'app' ? `console.log('revision ${n}');\n` : `module.exports.add = (a, b) => a + b; // revision ${n}\n`;
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_heal_${n}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: file, content }) } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise((r) => healSrv.listen(0, '127.0.0.1', r));
const healHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cli-heal-'));
const healWorkspaces = [];

// A provider defined in VS Code's settings, whose key VS Code keeps in the keychain (`${secret:vsc}`).
const vsSettings = process.platform === 'darwin'
  ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
  : process.platform === 'win32' ? path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'settings.json') : path.join(home, '.config', 'Code', 'User', 'settings.json');
fs.mkdirSync(path.dirname(vsSettings), { recursive: true });
fs.writeFileSync(vsSettings, JSON.stringify({ 'localpilot.providers': [{ id: 'vsc', type: 'openai', baseUrl: `${base}/local/v1`, displayName: 'From VS Code' }, { id: 'vslm', type: 'vscode-lm', baseUrl: 'vscode://lm' }], 'localpilot.telemetry.enabled': false, 'localpilot.skills.autoInstall': 'off', 'localpilot.autoClarify': false }, null, 2));

// The healing home's only provider is the scripted model. npm never reaches a registry from these runs.
const healSettings = vsSettings.replace(home, healHome);
fs.mkdirSync(path.dirname(healSettings), { recursive: true });
fs.writeFileSync(healSettings, JSON.stringify({ 'localpilot.providers': [{ id: 'heal', type: 'openai', baseUrl: `http://127.0.0.1:${healSrv.address().port}/v1` }], 'localpilot.telemetry.enabled': false, 'localpilot.skills.autoInstall': 'off', 'localpilot.autoClarify': false }, null, 2));
const healEnv = { HOME: healHome, USERPROFILE: healHome, APPDATA: path.join(healHome, 'AppData', 'Roaming'), XDG_CONFIG_HOME: path.join(healHome, '.config'), npm_config_registry: 'http://127.0.0.1:9/', npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
/** A throwaway workspace with these files (removed at the end). */
function healWorkspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cli-healws-'));
  healWorkspaces.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
/** The CLI in the healing home, in `cwd`. */
const healCli = (args, cwd, { env = {}, onSpawn } = {}) => cli(['--no-mcp', '-m', 'heal/coder', ...args], { cwd, env: { ...healEnv, ...env }, onSpawn });
const healCmd = (args, cwd, env = {}) => cli(args, { cwd, env: { ...healEnv, ...env } });
const ndjsonOf = (text) => text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
const runResult = (r) => ndjsonOf(r.stdout).find((x) => x.type === 'run_result');
const healingCommands = (records) => records.filter((x) => x.type === 'tool_start' && x.origin === 'healing').map((x) => String(x.args?.command ?? ''));
const nodePackage = (test) => JSON.stringify({ name: 'e2e-heal', version: '1.0.0', private: true, scripts: { test } }, null, 2);
const ADD_TEST = "const { add } = require('./math');\nif (add(2, 2) !== 4) {\n  console.error('test failed: add(2, 2) should be 4');\n  process.exit(1);\n}\nconsole.log('1 passing');\n";

/** Runs the CLI with a fresh environment (no real keys leak in) and returns its exit code and output. */
function cli(args, { input, env = {}, cwd = ws, onSpawn } = {}) {
  return new Promise((resolve) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/API_KEY|_TOKEN$|^LOCALPILOT_KEY_/.test(k)));
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...clean, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: path.join(home, '.config'), NO_COLOR: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => ((out += d), (stdout += d)));
    child.stderr.on('data', (d) => ((out += d), (stderr += d)));
    child.stdin.end(input ?? '');
    onSpawn?.(child);
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
  removeTemp(repo);

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
  removeTemp(deadHome);
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

  console.log('[self-healing]');
  {
    // A test that never passes: the fix attempts run out, the run is incomplete (exit 4) with its contract.
    const wsNever = healWorkspace({ 'package.json': nodePackage('node test.js'), 'test.js': ADD_TEST });
    r = await healCli(['-y', '-p', '--json', 'Implement add in math.js HEAL_MODE=bad'], wsNever);
    let records = ndjsonOf(r.stdout);
    let result = runResult(r);
    const neverSid = result?.sessionId;
    check('-p, test never passes: exit 4, NDJSON finishReason incomplete with outcome and contract', r.code === 4 && result?.finishReason === 'incomplete' && result.outcome === 'incomplete' && result.contract?.testsPassed === 'failed' && Array.isArray(result.contract.unresolved), { code: r.code, result, stderr: r.stderr.slice(0, 600) });
    const cards = records.filter((x) => x.type === 'recovery');
    check('recovery events stream as NDJSON: fix attempts and the failing check', cards.some((x) => x.phase === 'fixing' && x.attempt >= 1) && cards.some((x) => (x.checks ?? []).some((c) => c.id === 'npm:test' && c.status === 'failed')) && healingCommands(records).includes('npm test'), cards.map((x) => `${x.phase} ${x.attempt ?? ''} ${x.decision ?? ''}`));
    check('the model was asked to fix it more than once (distinct patches)', heal.writes >= 3 && /attempt [2-9]/.test(fs.readFileSync(path.join(wsNever, 'math.js'), 'utf8')), heal.writes);

    r = await healCmd(['recovery', 'list'], wsNever);
    check('recovery list: the incomplete task of this folder', r.code === 0 && !!neverSid && r.out.includes(neverSid) && /incomplete/.test(r.out), r.out);
    r = await healCmd(['recovery', 'show', String(neverSid)], wsNever);
    check('recovery show <sid>: root cause and next actions', r.code === 0 && /Root cause:.*add\(\) multiplied/.test(r.out) && /Next:/.test(r.out) && /\/recovery resume|localpilot recovery resume/.test(r.out) && r.out.includes(`localpilot recovery clear ${neverSid}`), r.out);
    r = await healCmd(['recovery', 'show', 'cli-nosuchsession'], wsNever);
    check('recovery show with an unknown id: exit 2', r.code === 2, r.out);

    // The same project with a correct implementation: verified, exit 0.
    const wsClean = healWorkspace({ 'package.json': nodePackage('node test.js'), 'test.js': ADD_TEST });
    r = await healCli(['-y', '-p', '--json', 'Implement add in math.js HEAL_MODE=good'], wsClean);
    result = runResult(r);
    check('clean run: the test passes, exit 0, outcome completed', r.code === 0 && result?.finishReason === 'completed' && result.outcome === 'completed' && result.contract?.testsPassed === 'passed', { code: r.code, result, stderr: r.stderr.slice(0, 600) });

    // A missing package: installing needs a mandatory prompt nobody can answer (no TTY, --yes does not cover it).
    const wsDep = healWorkspace({ 'package.json': nodePackage('node test.js'), 'test.js': "require('left-pad-e2e-missing');\nconsole.log('1 passing');\n" });
    r = await healCli(['-y', '--json', 'Implement add in math.js HEAL_MODE=good'], wsDep);
    result = runResult(r);
    const depSid = result?.sessionId;
    const depShow = await healCmd(['recovery', 'show', String(depSid), '--json'], wsDep);
    let state;
    try { state = JSON.parse(depShow.stdout.slice(depShow.stdout.indexOf('{'))); } catch { state = undefined; }
    check('missing dependency with --yes and no TTY: exit 5, blocked', r.code === 5 && result?.finishReason === 'blocked' && result.outcome === 'blocked', { code: r.code, result, stderr: r.stderr.slice(0, 600) });
    check('blocked: approval needed recorded, no install attempted', state?.phase === 'blocked' && state.intervention?.reason === 'approval_needed' && state.pendingAction?.status !== 'done' && !fs.existsSync(path.join(wsDep, 'node_modules')) && !fs.existsSync(path.join(wsDep, 'package-lock.json')), { phase: state?.phase, intervention: state?.intervention?.reason, pending: state?.pendingAction });

    // No checks for the changed file: done but unverified, which --require-verified turns into exit 4.
    const wsNone = healWorkspace({ 'README.md': '# scratch\n' });
    r = await healCli(['-y', '-p', '--require-verified', 'Write app.js HEAL_MODE=app'], wsNone);
    check('--require-verified with no discovered checks: exit 4, "Not verified" shown', r.code === 4 && /Not verified/i.test(r.stderr), r.out);
    r = await healCli(['-y', '-p', '--json', 'Write app.js HEAL_MODE=app'], wsNone);
    result = runResult(r);
    check('no discovered checks without --require-verified: exit 0, completed_unverified', r.code === 0 && result?.outcome === 'completed_unverified' && result.finishReason === 'completed', { code: r.code, result });

    // .localpilot/checks.json is workspace-controlled: ignored unless the workspace is trusted.
    const verify = "require('fs').writeFileSync(require('path').join(__dirname, 'verified.txt'), String(Date.now()));\nconsole.log('verified');\n";
    const wsChecks = healWorkspace({ '.localpilot/checks.json': JSON.stringify({ checks: [{ id: 'custom:verify', kind: 'test', command: 'node verify.js' }] }), 'verify.js': verify });
    r = await healCli(['-y', '-p', '--json', 'Write app.js HEAL_MODE=app'], wsChecks);
    result = runResult(r);
    check('checks.json ignored without LOCALPILOT_TRUST_WORKSPACE=1', r.code === 0 && result?.outcome === 'completed_unverified' && !healingCommands(ndjsonOf(r.stdout)).includes('node verify.js') && !fs.existsSync(path.join(wsChecks, 'verified.txt')), { code: r.code, result, cmds: healingCommands(ndjsonOf(r.stdout)) });
    r = await healCli(['-y', '-p', '--json', 'Write app.js again HEAL_MODE=app'], wsChecks, { env: { LOCALPILOT_TRUST_WORKSPACE: '1' } });
    result = runResult(r);
    check('checks.json used with LOCALPILOT_TRUST_WORKSPACE=1', r.code === 0 && result?.outcome === 'completed' && healingCommands(ndjsonOf(r.stdout)).includes('node verify.js') && fs.existsSync(path.join(wsChecks, 'verified.txt')), { code: r.code, result, cmds: healingCommands(ndjsonOf(r.stdout)) });

    // A run stopped (SIGTERM) while its checks run: the recovery is kept as interrupted, the check process is killed,
    // and `-c`, `recovery list|resume|clear` reach it. Two such runs: a `-c` with a prompt starts a new task.
    const slow = "require('fs').writeFileSync(require('path').join(__dirname, 'started.flag'), String(process.pid));\nsetTimeout(() => process.exit(1), 20000);\n";
    const gone = async (pid) => {
      for (let i = 0; i < 30; i++) {
        try { process.kill(pid, 0); } catch { return true; }
        await new Promise((res) => setTimeout(res, 100));
      }
      return false;
    };
    const interrupted = async (label) => {
      const dir = healWorkspace({ 'package.json': nodePackage('node slow-test.js'), 'slow-test.js': slow });
      const flag = path.join(dir, 'started.flag');
      let signalled = false;
      const run = await healCli(['-y', '-p', 'Implement add in math.js HEAL_MODE=good'], dir, {
        onSpawn: (child) => {
          const poll = setInterval(() => {
            if (fs.existsSync(flag)) {
              clearInterval(poll);
              signalled = true;
              child.kill('SIGTERM');
            }
          }, 100);
          child.on('exit', () => clearInterval(poll));
        },
      });
      const hist = await healCmd(['history', '--json'], dir);
      let sid;
      try { sid = JSON.parse(hist.out.slice(hist.out.indexOf('[')))[0]?.id; } catch { sid = undefined; }
      check(`SIGTERM during the checks (${label}): exit 143, the session is saved`, signalled && run.code === 143 && !!sid, { signalled, code: run.code, out: run.out.slice(0, 600), hist: hist.out.slice(0, 300) });
      const show = await healCmd(['recovery', 'show', String(sid), '--json'], dir);
      let st;
      try { st = JSON.parse(show.stdout.slice(show.stdout.indexOf('{'))); } catch { st = undefined; }
      const lock = path.join(healHome, '.localpilot', 'recovery', `${encodeURIComponent(String(sid))}.lock`);
      check(`SIGTERM (${label}): phase interrupted persisted, owner lock released`, show.code === 0 && st?.phase === 'interrupted' && !fs.existsSync(lock), { code: show.code, phase: st?.phase, lock: fs.existsSync(lock) });
      const pid = Number(fs.existsSync(flag) ? fs.readFileSync(flag, 'utf8') : NaN);
      check(`SIGTERM (${label}): the running check process was killed, not left running`, Number.isInteger(pid) && pid > 0 && (await gone(pid)), pid);
      return { dir, sid };
    };

    const intA = await interrupted('-c');
    r = await healCmd(['recovery', 'list'], intA.dir);
    check('recovery list: the interrupted recovery', r.code === 0 && !!intA.sid && r.out.includes(intA.sid) && /interrupted/.test(r.out), r.out);
    r = await healCli(['-c', '-p', 'HEAL_TALK are you there?'], intA.dir);
    check('localpilot -c on an interrupted session prints the recovery state', r.code === 0 && /Recovery interrupted/.test(r.out) && !!intA.sid && r.out.includes(`localpilot recovery resume ${intA.sid}`) && /Hi from the healing model/.test(r.stdout), r.out);

    // `recovery resume`: the checks re-run before the model is asked again, no edit is replayed, and it completes.
    const intB = await interrupted('resume');
    fs.writeFileSync(path.join(intB.dir, 'slow-test.js'), "console.log('1 passing');\n");
    const writesBefore = heal.writes;
    const resumeStarted = Date.now();
    r = await healCli(['recovery', 'resume', String(intB.sid), '-y', '-p', '--json'], intB.dir);
    records = ndjsonOf(r.stdout);
    result = runResult(r);
    const checkStart = records.find((x) => x.type === 'tool_start' && x.origin === 'healing' && /npm test/.test(String(x.args?.command ?? '')));
    const newWrites = heal.writeTimes.slice(writesBefore).filter((t) => t >= resumeStarted);
    check('recovery resume: the checks re-run before any model edit', r.code === 0 && !!checkStart && newWrites.every((t) => t >= checkStart.ts) && records.filter((x) => x.type === 'tool_start' && x.name === 'write_file' && x.origin !== 'healing').every((x) => x.ts >= checkStart.ts), { code: r.code, checkStart: checkStart?.ts, newWrites, stderr: r.stderr.slice(0, 600) });
    check('recovery resume: outcome completed', result?.outcome === 'completed' && result.finishReason === 'completed', { code: r.code, result });
    r = await healCmd(['recovery', 'clear', String(intB.sid)], intB.dir);
    const listed = await healCmd(['recovery', 'list'], intB.dir);
    check('recovery clear <sid>: gone from recovery list', r.code === 0 && listed.code === 0 && !listed.out.includes(String(intB.sid)), { clear: r.out, list: listed.out });

    // The model server fails the first requests, then answers: retried, and the run completes.
    const wsRetry = healWorkspace({ 'README.md': '# retry\n' });
    const before = heal.chats;
    heal.down = 2;
    r = await healCli(['-y', '--json', 'HEAL_TALK say hi'], wsRetry);
    result = runResult(r);
    records = ndjsonOf(r.stdout);
    check('server down for the first requests, then up: retried, exit 0', r.code === 0 && result?.finishReason === 'completed' && heal.down === 0 && heal.chats - before >= 3 && /Hi from the healing model/.test(result.text ?? ''), { code: r.code, result, stderr: r.stderr.slice(0, 600) });
    check('the retries stream as recovery events (model_unavailable)', records.some((x) => x.type === 'recovery' && x.phase === 'retrying' && x.category === 'model_unavailable'), records.filter((x) => x.type === 'recovery'));

    // The model server keeps failing: exit 1 and the outcome `failed` is persisted.
    const wsDown = healWorkspace({ 'README.md': '# down\n' });
    heal.alwaysDown = true;
    try {
      r = await healCli(['-y', '--json', 'HEAL_TALK say hi'], wsDown);
    } finally {
      heal.alwaysDown = false;
    }
    result = runResult(r);
    const downShow = await healCmd(['recovery', 'show', String(result?.sessionId), '--json'], wsDown);
    try { state = JSON.parse(downShow.stdout.slice(downShow.stdout.indexOf('{'))); } catch { state = undefined; }
    check('server down permanently: exit 1, outcome failed', r.code === 1 && result?.outcome === 'failed' && result.finishReason === 'error', { code: r.code, result, stderr: r.stderr.slice(0, 600) });
    check('server down permanently: outcome failed persisted with the model_unavailable intervention', state?.outcome === 'failed' && state.intervention?.reason === 'model_unavailable', { outcome: state?.outcome, phase: state?.phase, intervention: state?.intervention });
  }

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
  healSrv.close();
  for (const dir of [healHome, ...healWorkspaces]) {
    removeTemp(dir);
  }
  removeTemp(home);
  removeTemp(ws);
}
console.log(failures ? `\n${failures} CLI check(s) FAILED` : '\nAll CLI end-to-end checks passed');
process.exit(failures ? 1 : 0);
