import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { addMcpFileServer, catalogSecretName, catalogServerConfig, freeServerName, loadMcpCatalog, registryToCatalog, validateMcpCatalog } from '../mcp/catalog';
import { normalizeMcpServers } from '../mcp/config';
import { ensureMcpFile, MCP_FILE_TEMPLATE, mcpConfigTargets } from '../ui/mcpConfigEditor';

const CATALOG = path.resolve(__dirname, '..', '..', 'media', 'mcp-catalog.json');

suite('MCP catalog (pure)', () => {
  test('the bundled catalog is valid: ~30 servers, unique ids, each runnable locally or remotely', async () => {
    const { entries, problems } = await loadMcpCatalog(CATALOG);
    assert.deepStrictEqual(problems, []);
    assert.ok(entries.length >= 25, `${entries.length} servers`);
    for (const id of ['filesystem', 'git', 'github', 'postgres', 'sqlite', 'playwright', 'fetch', 'memory']) {
      assert.ok(entries.some((e) => e.id === id), `${id} is in the catalog`);
    }
    for (const e of entries) {
      // Every install produces a configuration the server-file reader accepts.
      const values = Object.fromEntries((e.install?.env ?? []).map((v) => [v.name, v.secret === false ? '/tmp/x' : `\${secret:${catalogSecretName(e.id, v.name)}}`]));
      for (const how of [...(e.install ? ['local' as const] : []), ...(e.remote ? ['remote' as const] : [])]) {
        const { problems: p } = normalizeMcpServers({ mcpServers: { [e.id]: catalogServerConfig(e, how, values) } });
        assert.deepStrictEqual(p, [], `${e.id} (${how})`);
      }
      for (const a of e.install?.args ?? []) {
        for (const m of a.matchAll(/\$\{env:([A-Za-z_]\w*)\}/g)) {
          assert.ok(e.install!.env?.some((v) => v.name === m[1]), `${e.id}: \${env:${m[1]}} is a declared variable`);
        }
      }
    }
  });

  test('the validator reports broken entries and keeps the good ones', () => {
    const { entries, problems } = validateMcpCatalog({
      servers: [
        { id: 'ok', name: 'OK', tagline: 't', tags: ['x'], remote: { url: 'https://ok.dev/mcp' } },
        { id: 'ok', name: 'Dup', tagline: 't', tags: [], remote: { url: 'https://ok.dev/mcp' } },
        { id: 'Bad Id', name: 'B', tagline: 't', tags: [], install: { command: 'npx', args: [] } },
        { id: 'noenv', name: 'N', tagline: 't', tags: [], install: { command: 'npx', args: ['x'], env: [{ name: 'A-B', required: true }] } },
        { id: 'nothing', name: 'N', tagline: 't', tags: [] },
      ],
    });
    assert.deepStrictEqual(entries.map((e) => e.id), ['ok']);
    assert.ok(problems.some((p) => p.startsWith('"ok": duplicate')));
    assert.ok(problems.some((p) => p.startsWith('"Bad Id"')));
    assert.ok(problems.some((p) => p.startsWith('"noenv": "install.env[0]"')));
    assert.ok(problems.some((p) => p === '"nothing": needs "install" or "remote"'));
    assert.deepStrictEqual(validateMcpCatalog([]).problems, ['expected { "servers": [ … ] }']);
  });

  test('install: variables fill the arguments or the environment; secrets stay references', () => {
    const entry = { id: 'db', name: 'DB', tagline: 't', tags: [], install: { command: 'npx', args: ['-y', 'srv', '${env:URL}'], env: [{ name: 'URL', required: true, arg: true }, { name: 'TOKEN', required: true }, { name: 'OPT', required: false }] }, remote: { url: 'https://db.dev/mcp' } };
    assert.deepStrictEqual(catalogServerConfig(entry, 'local', { URL: '${secret:mcp.db.URL}', TOKEN: '${secret:mcp.db.TOKEN}' }), { command: 'npx', args: ['-y', 'srv', '${secret:mcp.db.URL}'], env: { TOKEN: '${secret:mcp.db.TOKEN}' } });
    assert.deepStrictEqual(catalogServerConfig(entry, 'remote'), { url: 'https://db.dev/mcp' });
    assert.strictEqual(catalogSecretName('my db', 'API_KEY'), 'mcp.my_db.API_KEY');
    assert.strictEqual(freeServerName('git', ['git', 'git-2']), 'git-3');
    assert.strictEqual(freeServerName('git', []), 'git');
  });

  test('registry pages map to catalog entries (current and earlier shapes)', () => {
    const page = registryToCatalog({
      servers: [
        { server: { name: 'io.github.acme/weather', description: 'Weather', repository: { url: 'https://github.com/acme/weather' }, packages: [{ registryType: 'npm', identifier: '@acme/weather', version: '1.2.0', transport: { type: 'stdio' }, environmentVariables: [{ name: 'API_KEY', isRequired: true, isSecret: true }] }] } },
        { server: { name: 'com.example/hosted', description: 'Hosted', remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }] } },
        { name: 'old/py', description: 'Old shape', packages: [{ registry_name: 'pypi', name: 'old-py', version: 'latest', environment_variables: [{ name: 'X' }] }] },
        { server: { name: 'nothing/to-run' } },
      ],
      metadata: { nextCursor: 'abc' },
    });
    assert.strictEqual(page.nextCursor, 'abc');
    assert.deepStrictEqual(page.entries.map((e) => e.id), ['weather', 'hosted', 'py']);
    assert.deepStrictEqual(page.entries[0].install, { command: 'npx', args: ['-y', '@acme/weather@1.2.0'], env: [{ name: 'API_KEY', required: true, description: undefined, secret: undefined, default: undefined }] });
    assert.deepStrictEqual(page.entries[1].remote, { url: 'https://mcp.example.com/mcp' });
    assert.deepStrictEqual(page.entries[2].install?.args, ['old-py']);
    assert.ok(page.entries.every((e) => e.origin === 'registry' && e.tags.includes('registry')));
  });

  test('adds a server to a server file without touching the others; refuses to drop comments', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mcp-cat-'));
    try {
      const file = path.join(dir, 'mcp.json');
      await addMcpFileServer(file, 'one', { command: 'npx', args: ['a'] });
      await fs.writeFile(file, JSON.stringify({ other: 1, mcpServers: { one: { command: 'npx', args: ['a'], custom: true } } }));
      await addMcpFileServer(file, 'two', { url: 'https://x.dev/mcp' });
      assert.deepStrictEqual(JSON.parse(await fs.readFile(file, 'utf8')), { other: 1, mcpServers: { one: { command: 'npx', args: ['a'], custom: true }, two: { url: 'https://x.dev/mcp' } } });
      await assert.rejects(addMcpFileServer(file, 'two', { url: 'https://y.dev' }), /already defined/);
      await fs.writeFile(file, '{\n  // mine\n  "mcpServers": {}\n}\n');
      await assert.rejects(addMcpFileServer(file, 'three', { command: 'x' }), /comments/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('installing into a flat server file keeps the servers it already had', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mcp-cat-'));
    try {
      const file = path.join(dir, 'mcp.json');
      await fs.writeFile(file, JSON.stringify({ old: { command: 'node', args: ['old.js'] } }));
      await addMcpFileServer(file, 'new', { url: 'https://x.dev/mcp' });
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      assert.strictEqual(raw.mcpServers, undefined);
      const { servers, problems } = normalizeMcpServers(raw);
      assert.deepStrictEqual(problems, []);
      assert.deepStrictEqual(Object.keys(servers).sort(), ['new', 'old']);
      await assert.rejects(addMcpFileServer(file, 'old', { command: 'x' }), /already defined/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

suite('MCP configuration editing (pure)', () => {
  test('lists the user file, each folder\'s .mcp.json and settings.json', () => {
    const t = mcpConfigTargets([{ name: 'a', path: '/w/a' }, { name: 'b', path: '/w/b' }], '/home/u/.localpilot/mcp.json');
    assert.deepStrictEqual(t.map((x) => [x.kind, x.file]), [['user', '/home/u/.localpilot/mcp.json'], ['project', path.join('/w/a', '.mcp.json')], ['project', path.join('/w/b', '.mcp.json')], ['settings', undefined]]);
    assert.strictEqual(t[1].label, 'Workspace .mcp.json (a)');
    assert.strictEqual(mcpConfigTargets([{ name: 'a', path: '/w/a' }], '/u.json')[1].label, 'Workspace .mcp.json');
  });

  test('a missing file is created from the template; an existing one is kept', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mcp-edit-'));
    try {
      const file = path.join(dir, 'sub', '.mcp.json');
      assert.strictEqual(await ensureMcpFile(file), true);
      assert.strictEqual(await fs.readFile(file, 'utf8'), MCP_FILE_TEMPLATE);
      assert.deepStrictEqual(normalizeMcpServers(JSON.parse(MCP_FILE_TEMPLATE)), { servers: {}, problems: [] });
      await fs.writeFile(file, '{"mcpServers":{"x":{"command":"y"}}}');
      assert.strictEqual(await ensureMcpFile(file), false);
      assert.match(await fs.readFile(file, 'utf8'), /"x"/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
