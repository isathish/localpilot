import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { canonicalToolName, evaluatePermission, forgetMcpToolOrigin, registerMcpToolOrigin, toolNames } from '../agent/permissions';
import { emptySettings } from '../agent/settings';
import { agentToolFilter, toolInFilter } from '../agent/toolAliases';
import { parseJsonc } from '../agent/jsonc';
import { setMcpFileServerEnabled } from '../mcp/config';
import { setJsoncDisabled } from '../mcp/jsoncEdit';
import type { McpManager } from '../mcp/mcpManager';
import { withoutMcpPromptImages } from '../mcp/prompts';
import { mcpToolName } from '../mcp/toolNames';
import { handleMcpChatAction, McpChatMessage } from '../ui/mcpChat';

suite('MCP identity, prompt images, popover status and in-place server switches', () => {
  test('mcp_read_resource answers to its own name and to the rules of the server it reads', () => {
    assert.deepStrictEqual(toolNames('mcp_read_resource'), ['mcp_read_resource', 'ReadMcpResourceTool']);
    assert.strictEqual(canonicalToolName('mcp_read_resource'), 'ReadMcpResourceTool');
    const deny = { ...emptySettings().permissions, deny: ['mcp__my_srv'] };
    assert.strictEqual(evaluatePermission(deny, 'mcp_read_resource', { server: 'my_srv', uri: 'file:///a' }).decision, 'deny');
    assert.strictEqual(evaluatePermission(deny, 'mcp_read_resource', { server: 'other', uri: 'file:///a' }).decision, 'none');
    const ask = { ...emptySettings().permissions, ask: ['mcp__plugin_kit_db'] };
    assert.strictEqual(evaluatePermission(ask, 'mcp_read_resource', { server: 'kit:db', uri: 'x://y' }).decision, 'ask');
    // A rule for one tool of the server does not cover its resources, and the old `mcp__read` misreading is gone.
    const tool = { ...emptySettings().permissions, deny: ['mcp__my_srv__query', 'mcp__read'] };
    assert.strictEqual(evaluatePermission(tool, 'mcp_read_resource', { server: 'my_srv', uri: 'u' }).decision, 'none');
  });

  test('agent tool lists find plugin and collision-hashed MCP tools by their Claude names', () => {
    const plugin = mcpToolName('kit:db', 'q');
    const hashed = mcpToolName('a__b', 'c', true);
    registerMcpToolOrigin(plugin, 'kit:db', 'q');
    registerMcpToolOrigin(hashed, 'a__b', 'c');
    try {
      const filter = new Set(agentToolFilter(['Read', 'mcp__plugin_kit_db__q', 'mcp__a__b__c']));
      assert.ok(filter.has('read_file'));
      assert.ok(toolInFilter(plugin, filter), 'plugin tool by its mcp__plugin_… name');
      assert.ok(toolInFilter(hashed, filter), 'hashed tool by its mcp__server__tool name');
      assert.ok(toolInFilter(plugin, new Set(agentToolFilter(['mcp__kit_db__q']))));
      assert.ok(toolInFilter(plugin, new Set(agentToolFilter(['mcp__plugin_kit_db']))), 'a whole server');
      assert.ok(!toolInFilter('run_command', filter));
    } finally {
      forgetMcpToolOrigin(plugin);
      forgetMcpToolOrigin(hashed);
    }
  });

  test('an /mcp: turn expanded again sends only the user images, not the prompt ones again', () => {
    const stored = { images: ['user1', 'p1', 'p2'], meta: { mcpPromptImages: 2 } };
    assert.deepStrictEqual(withoutMcpPromptImages(stored.images, stored), ['user1']);
    assert.strictEqual(withoutMcpPromptImages(['p1', 'p2'], { images: ['p1', 'p2'], meta: { mcpPromptImages: 2 } }), undefined);
    // An edit that removed a prompt image keeps what the user left.
    assert.deepStrictEqual(withoutMcpPromptImages(['user1', 'p2'], stored), ['user1', 'p2']);
    assert.deepStrictEqual(withoutMcpPromptImages(['a'], { images: ['a'] }), ['a']);
  });

  test('a failed popover action sends the real status back', async () => {
    const sent: McpChatMessage[] = [];
    const toasts: string[] = [];
    const mcp = {
      status: [{ name: 'srv', state: 'running', tools: 2, source: 'plugin' }],
      setEnabled: async () => {
        throw new Error('srv comes from a plugin');
      },
      restart: async () => false,
    } as unknown as McpManager;
    await handleMcpChatAction(mcp, { type: 'mcpToggle', name: 'srv', enabled: false }, (_l, t) => toasts.push(t), (m) => sent.push(m));
    assert.deepStrictEqual(toasts, ['srv comes from a plugin']);
    assert.strictEqual(sent[0]?.servers[0]?.state, 'running');
    await handleMcpChatAction(mcp, { type: 'mcpRestart', name: 'srv' }, (_l, t) => toasts.push(t), (m) => sent.push(m));
    assert.strictEqual(sent.length, 2);
  });

  test('switching a server off and on keeps the comments and layout of its file', async () => {
    const text = `{
  // team servers
  "mcpServers": {
    "db": {
      "command": "db-mcp", // the local binary
      "enabled": true,
      "args": ["--url", "http://x//y"]
    },
    /* scratch */
    "web": { "url": "https://w" }
  }
}
`;
    const off = setJsoncDisabled(text, ['mcpServers', 'db'], true);
    assert.ok(off.includes('// team servers') && off.includes('// the local binary') && off.includes('/* scratch */'));
    assert.ok(!off.includes('"enabled"'));
    assert.deepStrictEqual((parseJsonc(off) as { mcpServers: Record<string, unknown> }).mcpServers.db, { command: 'db-mcp', args: ['--url', 'http://x//y'], disabled: true });
    assert.ok(off.includes('      "args": ["--url", "http://x//y"],\n      "disabled": true\n    },'), off);
    const on = setJsoncDisabled(off, ['mcpServers', 'db'], false);
    assert.strictEqual(on, text.replace('      "enabled": true,\n', ''));
    const flat = setJsoncDisabled('{ "web": { "url": "https://w" } }', ['web'], true);
    assert.strictEqual(flat, '{ "web": { "url": "https://w", "disabled": true } }');
    assert.strictEqual(setJsoncDisabled('{"a":{}}', ['a'], true), '{"a":{ "disabled": true }}');
    assert.strictEqual(setJsoncDisabled('{"a":{"x":1,"disabled":false,}}', ['a'], true), '{"a":{"x":1,"disabled":true,}}');

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mcp-edit-'));
    try {
      const file = path.join(dir, '.mcp.json');
      await fs.writeFile(file, text);
      await setMcpFileServerEnabled(file, 'web', false);
      const written = await fs.readFile(file, 'utf8');
      assert.ok(written.includes('// the local binary') && written.includes('"web": { "url": "https://w", "disabled": true }'), written);
      await setMcpFileServerEnabled(file, 'web', true);
      assert.strictEqual(await fs.readFile(file, 'utf8'), text);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
