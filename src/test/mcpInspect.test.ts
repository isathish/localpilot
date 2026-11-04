import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { toolNames } from '../agent/permissions';
import { mcpContentToResult, mcpResourceText, mcpToolVisibleToModel } from '../mcp/content';
import { McpManager } from '../mcp/mcpManager';
import { mapPromptArgs, mcpPromptUsage, parseMcpSlash, promptMessagesToText, splitPromptArgs } from '../mcp/prompts';
import { legacyMcpToolName, mcpToolName, splitMcpToolName } from '../mcp/toolNames';
import { ToolRegistry } from '../tools/registry';
import { ToolContext } from '../types';

const LONG = 'a_really_long_tool_name_that_goes_on_and_on_past_the_provider_limit';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A stdio server with tools (one long-named, one app-only, one returning an image), resources, a template and prompts. */
const SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  const ok = (result) => send({ id: msg.id, result });
  if (msg.method === 'initialize') ok({ protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'rich', version: '1' } });
  else if (msg.method === 'tools/list') ok({ tools: [
    { name: 'shot', description: 'Takes a picture', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'page' }, full: { type: 'boolean' } }, required: ['url'] } },
    { name: '${LONG}', inputSchema: { type: 'object', properties: {} } },
    { name: 'app_only', _meta: { ui: { visibility: ['app'] } } },
  ] });
  else if (msg.method === 'tools/call' && msg.params.name === 'shot') ok({ content: [{ type: 'text', text: 'captured' }, { type: 'image', data: '${PNG}', mimeType: 'image/png' }, { type: 'resource_link', uri: 'file:///shot.png', mimeType: 'image/png' }] });
  else if (msg.method === 'tools/call') ok({ content: [{ type: 'resource', resource: { uri: 'mem://x', mimeType: 'text/plain', text: 'embedded' } }] });
  else if (msg.method === 'resources/list') ok({ resources: [{ uri: 'mem://readme', name: 'Readme', mimeType: 'text/markdown' }] });
  else if (msg.method === 'resources/templates/list') ok({ resourceTemplates: [{ uriTemplate: 'mem://notes/{id}', name: 'Note' }] });
  else if (msg.method === 'resources/read') ok({ contents: [{ uri: msg.params.uri, mimeType: 'text/markdown', text: '# Readme of ' + msg.params.uri }] });
  else if (msg.method === 'prompts/list') ok({ prompts: [{ name: 'review', description: 'Review a branch', arguments: [{ name: 'branch', required: true }, { name: 'focus' }] }] });
  else if (msg.method === 'prompts/get') ok({ messages: [{ role: 'user', content: { type: 'text', text: 'Review ' + msg.params.arguments.branch + ' for ' + (msg.params.arguments.focus || 'everything') } }] });
  else if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'method not found' } });
});
`;

/** Declares no resources or prompts and answers templates with MethodNotFound: the lists stay empty, the start succeeds. */
const PLAIN = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'plain', version: '1' } } });
  else if (msg.method === 'tools/list') send({ id: msg.id, result: { tools: [{ name: 'one' }] } });
  else if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'method not found' } });
});
`;

const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({ sessionId: 't', signal: new AbortController().signal, requestApproval: async () => true, progress: () => undefined, trackChange: async () => undefined, depth: 0, ...over }) as ToolContext;

suite('LocalPilot MCP names, content and prompts (pure)', () => {
  test('tool names: mcp_<server>__<tool>, hashed when sanitised or cut, at most 64 characters', () => {
    assert.strictEqual(mcpToolName('my_db', 'run_query'), 'mcp_my_db__run_query');
    assert.match(mcpToolName('kit:db', 'q'), /^mcp_kit_db__q_[0-9a-f]{8}$/);
    const a = mcpToolName('srv', LONG);
    const b = mcpToolName('srv', `${LONG}_2`);
    assert.strictEqual(a.length, 64);
    assert.notStrictEqual(a, b, 'two long names that share a prefix stay apart');
    assert.match(mcpToolName('srv', 'x', true), /^mcp_srv__x_[0-9a-f]{8}$/);
    assert.strictEqual(legacyMcpToolName('my_db', 'run_query'), 'mcp_my_db_run_query');
    assert.deepStrictEqual(splitMcpToolName('mcp_my_db__run_query'), { server: 'my_db', tool: 'run_query' });
  });

  test('content: text, images, embedded resources, resource links and structured content', () => {
    const r = mcpContentToResult(
      [
        { type: 'text', text: 'hello' },
        { type: 'image', data: PNG, mimeType: 'image/png' },
        { type: 'image', data: 'x', mimeType: 'image/tiff' },
        { type: 'resource', resource: { uri: 'file:///a.md', mimeType: 'text/markdown', text: '# A' } },
        { type: 'resource_link', uri: 'file:///b.txt', name: 'b', mimeType: 'text/plain' },
        { type: 'audio', data: 'x', mimeType: 'audio/wav' },
      ],
      undefined,
      'srv'
    );
    assert.deepStrictEqual(r.images, [{ name: 'srv-image-1.png', data: PNG, mime: 'image/png' }]);
    assert.strictEqual(r.text, 'hello\n[image srv-image-1.png (image/png)]\n[image content (image/tiff) not shown]\n[resource file:///a.md (text/markdown)]\n# A\n[resource file:///b.txt (text/plain)] b\n[audio content (audio/wav)]');
    assert.strictEqual(mcpContentToResult([], { n: 1 }).text, '{\n  "n": 1\n}');
    assert.strictEqual(mcpResourceText([{ uri: 'u', mimeType: 'application/pdf', blob: 'AAAA' }]).text, '[resource u (application/pdf)]\n[binary application/pdf, 0 KB]');
  });

  test('content: image data that is not base64 is never passed on', () => {
    const r = mcpContentToResult(
      [
        { type: 'image', data: 'x" style="position:fixed"><a href="https://evil">', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'u', mimeType: 'image/png', blob: '<svg onload=1>' } },
        { type: 'image', data: `${PNG.slice(0, 20)}\n${PNG.slice(20)}`, mimeType: 'image/png' },
      ],
      undefined,
      'srv'
    );
    assert.deepStrictEqual(r.images, [{ name: 'srv-image-1.png', data: PNG, mime: 'image/png' }]);
    assert.strictEqual(r.text, '[image content (image/png) not shown]\n[image content (image/png) not shown]\n[image srv-image-1.png (image/png)]');
  });

  test('visibility: only tools whose _meta.ui.visibility leaves out the model are hidden', () => {
    assert.ok(mcpToolVisibleToModel({}));
    assert.ok(mcpToolVisibleToModel({ _meta: { ui: { visibility: ['model', 'app'] } } }));
    assert.ok(!mcpToolVisibleToModel({ _meta: { ui: { visibility: ['app'] } } }));
    assert.ok(!mcpToolVisibleToModel({ _meta: { ui: { visibility: 'app' } } }));
  });

  test('prompt slash commands: parsing, quoting, positional and key=value arguments', () => {
    assert.deepStrictEqual(parseMcpSlash('/mcp:git:review main'), { server: 'git', prompt: 'review', args: 'main' });
    assert.deepStrictEqual(parseMcpSlash('  /mcp:kit:db:q'), { server: 'kit:db', prompt: 'q', args: '' });
    assert.strictEqual(parseMcpSlash('/mcp: review'), undefined);
    assert.deepStrictEqual(splitPromptArgs(`a "b c" key='d e'`), ['a', 'b c', 'key=d e']);
    const declared = [{ name: 'branch', required: true }, { name: 'focus' }];
    assert.deepStrictEqual(mapPromptArgs('main the login flow', declared), { args: { branch: 'main', focus: 'the login flow' }, missing: [] });
    assert.deepStrictEqual(mapPromptArgs('focus=tests dev', declared), { args: { focus: 'tests', branch: 'dev' }, missing: [] });
    assert.deepStrictEqual(mapPromptArgs('focus=tests', declared).missing, ['branch']);
    assert.deepStrictEqual(mapPromptArgs('a=1', []).args, { a: '1' }, 'with no declared arguments key=value passes through');
    assert.strictEqual(mcpPromptUsage('git', 'review', declared), '/mcp:git:review <branch> [focus]');
    assert.deepStrictEqual(promptMessagesToText({ messages: [{ role: 'user', content: { type: 'text', text: 'Do it' } }] }), { text: 'Do it', images: [] });
  });
});

suite('LocalPilot MCP inspection, rich results and prompts', () => {
  const cfg = vscode.workspace.getConfiguration('localpilot');
  let dir: string;
  let before: unknown;
  const log = vscode.window.createOutputChannel('LocalPilot MCP inspect test', { log: true });

  suiteSetup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mcp-insp-'));
    await fs.writeFile(path.join(dir, 'rich.js'), SERVER);
    await fs.writeFile(path.join(dir, 'plain.js'), PLAIN);
    before = cfg.inspect('mcpServers')?.globalValue;
  });
  suiteTeardown(async () => {
    await cfg.update('mcpServers', before, vscode.ConfigurationTarget.Global);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('names, images, visibility, status lists, resources, prompts, restart and switching off', async function () {
    this.timeout(40_000);
    const tools = new ToolRegistry();
    const mcp = new McpManager(tools, log, '0.0.0-test');
    try {
      await cfg.update('mcpServers', { my_srv: { command: process.execPath, args: [path.join(dir, 'rich.js')] }, plain: { command: process.execPath, args: [path.join(dir, 'plain.js')] } }, vscode.ConfigurationTarget.Global);
      await mcp.reload();

      // X6: names with "_" in the server, the long name and the hidden tool.
      const shot = tools.get('mcp_my_srv__shot');
      assert.ok(shot, 'registered as mcp_<server>__<tool>');
      const longName = tools.list().map((t) => t.definition.name).find((n) => n.startsWith('mcp_my_srv__a_really'));
      assert.ok(longName && longName.length <= 64 && /_[0-9a-f]{8}$/.test(longName), longName);
      assert.ok(!tools.list().some((t) => /app_only/.test(t.definition.name)), 'app-only tools are not offered to the model');
      assert.ok(toolNames('mcp_my_srv__shot').includes('mcp_my_srv_shot'), 'the old name still matches permission rules');
      assert.ok(toolNames('mcp_my_srv__shot').includes('mcp__my_srv__shot'));

      const r = await shot.execute({ url: 'x' }, ctx());
      assert.strictEqual(r.images?.length, 1);
      assert.strictEqual(r.images?.[0].mime, 'image/png');
      assert.match(r.content, /^captured\n\[image .+\.png \(image\/png\)\]\n\[resource file:\/\/\/shot\.png \(image\/png\)\]$/);
      assert.deepStrictEqual((r.data as { images: unknown[] }).images.length, 1, 'the chat gets the images to show inline');
      const embedded = await tools.get(longName!)!.execute({}, ctx());
      assert.strictEqual(embedded.content, '[resource mem://x (text/plain)]\nembedded');

      // X7: status with full lists.
      const st = mcp.status;
      const rich = st.find((s) => s.name === 'my_srv')!;
      assert.strictEqual(rich.state, 'connected');
      assert.strictEqual(rich.tools, 2);
      assert.deepStrictEqual(rich.toolList?.[0].params, [
        { name: 'url', type: 'string', description: 'page', required: true },
        { name: 'full', type: 'boolean', description: undefined, required: false },
      ]);
      assert.deepStrictEqual(rich.resources, [{ uri: 'mem://readme', name: 'Readme', mimeType: 'text/markdown' }]);
      assert.deepStrictEqual(rich.resourceTemplates, [{ uriTemplate: 'mem://notes/{id}', name: 'Note' }]);
      assert.strictEqual(rich.prompts?.[0].name, 'review');
      const plain = st.find((s) => s.name === 'plain')!;
      assert.deepStrictEqual([plain.state, plain.resources, plain.resourceTemplates, plain.prompts], ['connected', [], [], []]);

      const read = tools.get('mcp_read_resource');
      assert.ok(read, 'mcp_read_resource is offered while a server has resources');
      assert.ok(read.readOnly && read.approvalKind === 'mcp');
      assert.match(read.definition.description, /mem:\/\/readme/);
      assert.strictEqual((await read.execute({ server: 'my_srv', uri: 'mem://readme' }, ctx())).content, '[resource mem://readme (text/markdown)]\n# Readme of mem://readme');
      assert.ok((await read.execute({ server: 'nope', uri: 'x' }, ctx())).isError);
      assert.ok((await read.execute({ server: 'my_srv', uri: 'mem://readme' }, ctx({ requestApproval: async () => false }))).isError, 'reading asks like other MCP calls');

      // X9: prompts.
      assert.deepStrictEqual(mcp.promptCommands.map((p) => [p.invoke, p.argumentHint]), [['/mcp:my_srv:review', '<branch> [focus]']]);
      assert.strictEqual((await mcp.getPrompt('my_srv', 'review', 'main the tests')).text, 'Review main for the tests');
      assert.strictEqual((await mcp.getPrompt('my_srv', 'review', 'focus=docs dev')).text, 'Review dev for docs');
      await assert.rejects(mcp.getPrompt('my_srv', 'review', ''), /missing branch/);
      await assert.rejects(mcp.getPrompt('my_srv', 'nope', ''), /no prompt "nope"/);

      // Restart, then switch off and on again (written to the setting).
      assert.strictEqual(await mcp.restart('my_srv'), true);
      assert.ok(tools.get('mcp_my_srv__shot'), 'tools are registered again after a restart');
      await mcp.setEnabled('my_srv', false);
      assert.strictEqual(mcp.status.find((s) => s.name === 'my_srv')?.state, 'disabled');
      assert.strictEqual((cfg.inspect<Record<string, { enabled?: boolean }>>('mcpServers')?.globalValue ?? {}).my_srv?.enabled, false);
      assert.ok(!tools.get('mcp_my_srv__shot') && !tools.get('mcp_read_resource'), 'a switched-off server withdraws its tools and the resource tool');
      await mcp.setEnabled('my_srv', true);
      assert.strictEqual(mcp.status.find((s) => s.name === 'my_srv')?.state, 'connected');
    } finally {
      mcp.dispose();
    }
  });
});
