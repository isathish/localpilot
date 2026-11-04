import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { McpManager } from '../mcp/mcpManager';
import { ToolRegistry } from '../tools/registry';

/** A stdio server offering one tool, named by `tool`. */
const server = (tool: string) => `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dev', version: '1' } } });
  else if (msg.method === 'tools/list') send({ id: msg.id, result: { tools: [{ name: '${tool}' }] } });
  else if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'method not found' } });
});
`;

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

suite('LocalPilot MCP server restart on script change', () => {
  const cfg = vscode.workspace.getConfiguration('localpilot');
  const log = vscode.window.createOutputChannel('LocalPilot MCP watch test', { log: true });
  let dir: string;
  let before: unknown;
  let beforeWatch: unknown;

  suiteSetup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mcp-restart-'));
    before = cfg.inspect('mcpServers')?.globalValue;
    beforeWatch = cfg.inspect('mcp.watchServerFiles')?.globalValue;
  });
  suiteTeardown(async () => {
    await cfg.update('mcpServers', before, vscode.ConfigurationTarget.Global);
    await cfg.update('mcp.watchServerFiles', beforeWatch, vscode.ConfigurationTarget.Global);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a workspace server script that changes restarts its server; with the setting off it does not', async function () {
    this.timeout(30_000);
    const script = path.join(dir, 'server.js');
    await fs.writeFile(script, server('one'));
    const tools = new ToolRegistry();
    const mcp = new McpManager(tools, log, '0.0.0-test');
    mcp.projectFolders = () => [dir];
    mcp.userFile = () => path.join(dir, 'none.json');
    try {
      await cfg.update('mcp.watchServerFiles', true, vscode.ConfigurationTarget.Global);
      await cfg.update('mcpServers', { dev: { command: process.execPath, args: [script] } }, vscode.ConfigurationTarget.Global);
      await mcp.reload();
      assert.ok(tools.get('mcp_dev__one'), 'started');
      await fs.writeFile(script, server('two'));
      assert.ok(await until(() => !!tools.get('mcp_dev__two'), 8000), 'restarted with the new script');
      assert.ok(!tools.get('mcp_dev__one'));

      await cfg.update('mcp.watchServerFiles', false, vscode.ConfigurationTarget.Global);
      await fs.writeFile(script, server('three'));
      await new Promise((r) => setTimeout(r, 1500));
      assert.ok(tools.get('mcp_dev__two') && !tools.get('mcp_dev__three'), 'not restarted with the setting off');
    } finally {
      mcp.dispose();
    }
  });
});
