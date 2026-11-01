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
const seen = { claudeKeys: [], claudeBodies: [], localChats: 0, omniChats: 0 };
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
    omni ? seen.omniChats++ : seen.localChats++;
    res.setHeader('content-type', 'text/event-stream');
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
fs.writeFileSync(vsSettings, JSON.stringify({ 'localpilot.providers': [{ id: 'vsc', type: 'openai', baseUrl: `${base}/local/v1`, displayName: 'From VS Code' }], 'localpilot.telemetry.enabled': false, 'localpilot.skills.autoInstall': 'off', 'localpilot.autoClarify': false }, null, 2));

/** Runs the CLI with a fresh environment (no real keys leak in) and returns its exit code and output. */
function cli(args, { input, env = {} } = {}) {
  return new Promise((resolve) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/API_KEY|_TOKEN$|^LOCALPILOT_KEY_/.test(k)));
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ws, env: { ...clean, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: path.join(home, '.config'), NO_COLOR: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.stdin.end(input ?? '');
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
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
