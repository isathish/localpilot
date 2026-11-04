/**
 * Smoke checks (bundled into scripts/smoke.ts) for the REPL's info commands driven through `infoSlash`: /mcp
 * enable|disable|restart (session-only, including a server switched off in its configuration), /yes, /settings
 * set|unset and masking, and /compact archiving what it summarised.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { infoSlash, InfoSlashContext } from '../src/cli/slash/info';
import { cliOverrides, isAutoApprove, loadSettings, setAutoApprove } from '../src/cli/vscodeShim';
import { McpManager } from '../src/mcp/mcpManager';
import { ToolRegistry } from '../src/tools/registry';
import { ChatMessage, Session } from '../src/types';

type Check = (name: string, cond: boolean, detail?: unknown) => void;
const plain = { bold: (s: string) => s, dim: (s: string) => s, red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s, amber: (s: string) => s, cyan: (s: string) => s };

export async function cliSlash(check: Check): Promise<void> {
  console.log('\n[CLI REPL slash commands: /mcp, /yes, /settings, /compact]');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cli-slash-'));
  const server = path.join(dir, 'server.js');
  fs.writeFileSync(server, `const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (l) => { const m = JSON.parse(l); const out = (r) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: r }) + '\\n');
  if (m.method === 'initialize') out({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'slash', version: '1' } });
  else if (m.method === 'tools/list') out({ tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] });
  else if (m.id !== undefined) out({}); });`);
  const prevCfg = process.env.LP_CONFIG;
  const cfg = JSON.stringify({ mcpServers: { lpon: { command: process.execPath, args: [server] }, lpoff: { command: process.execPath, args: [server], enabled: false } }, 'compaction.strategy': 'basic' });
  process.env.LP_CONFIG = cfg;
  const log = { info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as vscode.LogOutputChannel;
  const mgr = new McpManager(new ToolRegistry(), log, '1');
  const archived: { id: string; count: number; compactionIndex: number }[] = [];
  let saves = 0;
  const now = Date.now();
  const messages: ChatMessage[] = Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i % 2 ? 'answer' : 'question'} ${i} ${'detail '.repeat(30)}` }) as ChatMessage);
  const session = { id: 'cli-slash', title: 'slash', createdAt: now, updatedAt: now, model: 'stub/m', mode: 'agent', messageCount: messages.length, messages, contextTokens: 9_000, compactions: 0, attachments: [], todos: [], workingSet: [] } as unknown as Session;
  let promptRedraws = 0;
  let out = '';
  const ctx = {
    session: () => session,
    store: { save: () => saves++, archive: (id: string, msgs: ChatMessage[], o: { compactionIndex: number }) => archived.push({ id, count: msgs.length, compactionIndex: o.compactionIndex }) },
    providers: { resolve: async () => ({ provider: {}, model: { id: 'stub/m', name: 'Stub', providerId: 'stub', contextWindow: 32_000 } }), cachedModels: () => [] },
    skills: { allSkills: [], allAgents: [] },
    memory: { list: async () => [] },
    workspace: { instructionFiles: async () => [] },
    plugins: [],
    mcp: mgr,
    style: plain,
    md: (s: string) => s,
    status: () => undefined,
    onAutoApprove: () => promptRedraws++,
    out: { write: (s: string) => ((out += s), true) },
  } as unknown as InfoSlashContext;
  const run = async (cmd: string, arg = ''): Promise<string> => {
    out = '';
    await infoSlash(cmd, arg, ctx);
    return out;
  };
  const state = (name: string) => mgr.status.find((s) => s.name === name)?.state;
  const ws = vscode.workspace as unknown as { getConfiguration: (s?: string) => Record<string, unknown> };
  const origGet = ws.getConfiguration;
  try {
    await mgr.reload();
    check('/mcp: a server switched off in its configuration is listed as disabled', state('lpon') === 'connected' && state('lpoff') === 'disabled' && /lpoff disabled/.test(await run('mcp', 'list')), mgr.status);
    let said = await run('mcp', 'disable lpon');
    check('/mcp disable: stops the server for this session, its configuration untouched', state('lpon') === 'disabled' && /lpon disabled for this session/.test(said) && process.env.LP_CONFIG === cfg, { said, status: mgr.status });
    said = await run('mcp', 'enable lpoff');
    check('/mcp enable: starts a server whose configuration has enabled: false, and says it is running', state('lpoff') === 'connected' && /lpoff enabled for this session/.test(said) && /1 tool/.test(said) && process.env.LP_CONFIG === cfg, { said, status: mgr.status });
    said = await run('mcp', 'restart lpoff');
    check('/mcp restart: a server enabled for the session restarts', state('lpoff') === 'connected' && /lpoff restarted/.test(said), said);
    said = await run('mcp', 'enable lpon');
    check('/mcp enable: a server disabled for the session runs again', state('lpon') === 'connected' && /lpon enabled/.test(said), said);
    await run('mcp', 'disable lpoff');
    check('/mcp disable after a session enable: the server stops again', state('lpoff') === 'disabled', mgr.status);

    setAutoApprove(false);
    said = await run('yes', 'on');
    const onNow = isAutoApprove();
    const said2 = await run('yes', 'off');
    check('/yes on then /yes off: auto-approve switches and the prompt is redrawn each time', onNow && !isAutoApprove() && promptRedraws === 2 && /auto-approve on/.test(said) && /auto-approve off/.test(said2), { onNow, promptRedraws });
    await run('yes');
    check('/yes alone toggles', isAutoApprove());
    setAutoApprove(false);

    const updates: [string, unknown, unknown][] = [];
    ws.getConfiguration = (s?: string) => ({ ...origGet(s), update: async (k: string, v: unknown, t: unknown) => void updates.push([k, v, t]) });
    said = await run('settings', 'set thinking high');
    const said3 = await run('settings', 'unset localpilot.thinking');
    check('/settings set writes the user setting, /settings unset removes it', JSON.stringify(updates) === JSON.stringify([['thinking', 'high', vscode.ConfigurationTarget.Global], ['thinking', undefined, vscode.ConfigurationTarget.Global]]) && /thinking = "high" saved/.test(said) && /thinking removed/.test(said3), { updates, said, said3 });
    said = await run('settings', 'set not..a.key 1');
    check('/settings set with a bad key writes nothing', updates.length === 2 && /not a setting key/.test(said), said);
    ws.getConfiguration = origGet;

    cliOverrides.providers = [{ id: 'smk', type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-smoke-slash-secret' }];
    loadSettings();
    said = await run('settings', 'providers');
    check('/settings masks an apiKey', /providers = /.test(said) && !said.includes('sk-smoke-slash-secret') && said.includes('••••'), said);
    delete cliOverrides.providers;
    loadSettings();

    const before = session.messages.length;
    said = await run('compact');
    check('/compact on a long chat: fewer messages, a summary, the older ones archived and the session saved', session.messages.length < before && session.compactions === 1 && session.messages.some((m) => m.meta?.summary) && archived.length === 1 && archived[0].id === 'cli-slash' && archived[0].compactionIndex === 0 && archived[0].count > 0 && saves === 1 && /compacted \d+ messages/.test(said), { before, after: session.messages.length, archived, said });
  } finally {
    ws.getConfiguration = origGet;
    mgr.dispose();
    if (prevCfg === undefined) {
      delete process.env.LP_CONFIG;
    } else {
      process.env.LP_CONFIG = prevCfg;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
