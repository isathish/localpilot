import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { addMcpServerToFile, buildMcpEntry, mcpListRows, mcpTransportLabel, parseMcpArgs, removeMcpServerFromFile } from '../cli/mcpCmd';

suite('CLI mcp subcommand', () => {
  test('parses add with flags before and the command after --', () => {
    const a = parseMcpArgs(['add', 'db', '--env=PGURL=postgres://x', '--scope', 'project', '--', 'uvx', 'pg-mcp', '--readonly']);
    assert.strictEqual(a.action, 'add');
    assert.strictEqual(a.name, 'db');
    assert.deepStrictEqual(a.env, { PGURL: 'postgres://x' });
    assert.strictEqual(a.scope, 'project');
    assert.deepStrictEqual(a.target, ['uvx', 'pg-mcp', '--readonly']);
    assert.ifError(a.error);
  });

  test('parses a remote add and the other actions', () => {
    const a = parseMcpArgs(['add', 'docs', 'https://docs.example/mcp', '-H', 'X-Key: ${secret:docs}', '-t', 'http']);
    assert.deepStrictEqual([a.target, a.headers, a.transport], [['https://docs.example/mcp'], { 'X-Key': '${secret:docs}' }, 'http']);
    assert.strictEqual(parseMcpArgs(['rm', 'docs']).action, 'remove');
    assert.strictEqual(parseMcpArgs(['off', 'docs']).action, 'disable');
    assert.strictEqual(parseMcpArgs(['auth', 'docs']).action, 'auth');
    assert.strictEqual(parseMcpArgs([]).action, 'menu');
    assert.ok(parseMcpArgs(['ls', '--json']).json);
  });

  test('reports usage errors', () => {
    assert.match(parseMcpArgs(['disable']).error ?? '', /needs a server name/);
    assert.match(parseMcpArgs(['add', 'x', '--header', 'novalue']).error ?? '', /Name: value/);
    assert.match(parseMcpArgs(['add', 'x', '--scope', 'team']).error ?? '', /user or project/);
    assert.match(parseMcpArgs(['remove', 'a', 'b']).error ?? '', /unexpected argument/);
  });

  test('builds the file entry and refuses mismatched flags', () => {
    assert.deepStrictEqual(buildMcpEntry({ target: ['https://a.dev/sse'], transport: 'sse', headers: {}, env: {} }).entry, { type: 'sse', url: 'https://a.dev/sse' });
    assert.deepStrictEqual(buildMcpEntry({ target: ['node', 'srv.js'], headers: {}, env: { K: 'v' } }).entry, { command: 'node', args: ['srv.js'], env: { K: 'v' } });
    assert.ok(buildMcpEntry({ target: ['node'], headers: { A: 'b' }, env: {} }).error);
    assert.ok(buildMcpEntry({ target: ['https://a.dev'], transport: 'stdio', headers: {}, env: {} }).error);
    assert.strictEqual(mcpTransportLabel({ url: 'https://a.dev/sse' }), 'sse');
    assert.strictEqual(mcpTransportLabel({ command: 'x' }), 'stdio');
  });

  test('adds and removes servers in a file, keeping other keys', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mcp-cli-'));
    const file = path.join(dir, 'mcp.json');
    try {
      await fs.writeFile(file, JSON.stringify({ note: 'kept', mcpServers: { a: { command: 'a', custom: 1 } } }));
      assert.strictEqual(await addMcpServerToFile(file, 'b', { url: 'https://b.dev/mcp' }), 'added');
      await assert.rejects(addMcpServerToFile(file, 'b', { url: 'https://c.dev/mcp' }), /already defined/);
      assert.strictEqual(await addMcpServerToFile(file, 'b', { url: 'https://c.dev/mcp' }, true), 'replaced');
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.deepStrictEqual(saved, { note: 'kept', mcpServers: { a: { command: 'a', custom: 1 }, b: { url: 'https://c.dev/mcp' } } });
      assert.strictEqual(await removeMcpServerFromFile(file, 'a'), true);
      assert.strictEqual(await removeMcpServerFromFile(file, 'a'), false);
      assert.deepStrictEqual(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).mcpServers), ['b']);
      assert.deepStrictEqual((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp')), []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('lists the winning definition and what it overrides', () => {
    const rows = mcpListRows([
      { source: 'project', file: '/r/.mcp.json', servers: { gh: { url: 'https://gh.dev/mcp' } }, problems: [] },
      { source: 'user', file: '/h/mcp.json', servers: { gh: { command: 'gh-mcp' }, fs: { command: 'fs', enabled: false, env: { TOKEN: 's' } } }, problems: [] },
    ], () => false);
    assert.deepStrictEqual(rows.map((r) => [r.name, r.source, r.transport, r.enabled, r.trusted, r.shadows]), [
      ['gh', 'project', 'http', true, false, ['/h/mcp.json']],
      ['fs', 'user', 'stdio', false, undefined, []],
    ]);
    assert.deepStrictEqual(rows[1].envKeys, ['TOKEN']);
  });
});
