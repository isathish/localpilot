#!/usr/bin/env node
// Real-gateway end-to-end check: runs the built `localpilot` CLI against an OmniRoute (or LiteLLM) that is actually
// running, with real upstream providers. It adds the gateway as a provider in a throwaway HOME, tests it, lists its
// models, and has a real model read a file through a tool call and answer from it.
//
//   npm run e2e:gateway                                   # OmniRoute on http://127.0.0.1:20128
//   GATEWAY_URL=http://127.0.0.1:4000/v1 GATEWAY=litellm npm run e2e:gateway
//   GATEWAY_KEY=sk-…  GATEWAY_MODEL=openai/gpt-5.4  npm run e2e:gateway
//
// Start the gateway first (LocalPilot: Start Gateway, or `omniroute --port 20128 --no-open`) and connect at least one
// provider in its dashboard. Exit codes: 0 passed, 1 a check failed, 2 the gateway is not running or not ready.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.resolve('dist/cli.js');
const id = process.env.GATEWAY || 'omniroute';
const base = (process.env.GATEWAY_URL || 'http://127.0.0.1:20128/v1').replace(/\/+$/, '');
const key = process.env.GATEWAY_KEY;
if (!fs.existsSync(CLI)) {
  console.error('dist/cli.js missing — run `node esbuild.js` first (npm run e2e:gateway does)');
  process.exit(1);
}

// 1. Is the gateway up, and can it route anywhere?
let ids;
try {
  const res = await fetch(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  ids = ((await res.json()).data ?? []).map((m) => m.id);
} catch (e) {
  console.error(`✖ No gateway answers at ${base} (${e.message}).\n  Start it: LocalPilot: Start Gateway, or \`omniroute --port 20128 --no-open\`. Set GATEWAY_URL for another address.`);
  process.exit(2);
}
const routes = ids.filter((i) => /^auto(\/|$)/i.test(i));
const models = ids.filter((i) => !/^auto(\/|$)/i.test(i));
console.log(`  gateway at ${base}: ${models.length} provider model(s), ${routes.length} route(s)`);
if (!models.length) {
  console.error(`✖ ${id} is running but has no provider connected (it lists only ${routes.join(', ') || 'nothing'}).\n  Open its dashboard (${base.replace(/\/v1$/, '')}/), connect a provider, and run this again.`);
  process.exit(2);
}
const model = process.env.GATEWAY_MODEL || (routes.includes('auto/coding') ? 'auto/coding' : routes[0] || models[0]);

// 2. Through the real CLI, in a throwaway HOME so your settings are untouched.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-gw-home-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-gw-ws-'));
fs.writeFileSync(path.join(ws, 'secret.txt'), 'The magic number is 7341.\n');
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${name}`);
  if (!ok) {
    failures++;
    if (detail) {
      console.log(`      ${String(detail).slice(0, 1200).replace(/\n/g, '\n      ')}`);
    }
  }
};
const cli = (args, timeoutMs = 240_000) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ws, env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });

try {
  let r = await cli(['providers', 'add', id, '--url', base, ...(key ? ['--key', key] : [])]);
  check(`providers add ${id}: connected and its models listed`, r.code === 0 && /Connected/.test(r.out), r.out);
  r = await cli(['models']);
  check('models: the gateway models are marked cloud', new RegExp(`${id}/\\S+\\s+\\S+\\s+cloud`).test(r.out), r.out);
  r = await cli(['-y', '-p', '--no-mcp', '-m', `${id}/${model}`, 'Reply with exactly the word READY and nothing else.']);
  check(`a real answer through ${id}/${model}`, r.code === 0 && /READY/i.test(r.out), r.out);
  r = await cli(['-y', '-p', '--no-mcp', '-m', `${id}/${model}`, 'Read the file secret.txt with your tool and tell me the magic number in it.']);
  check('a real tool call through the gateway (read_file → answer)', r.code === 0 && /7341/.test(r.out), r.out);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} real-gateway check(s) FAILED` : `\nAll real-gateway checks passed with ${id}/${model}`);
process.exit(failures ? 1 : 0);
