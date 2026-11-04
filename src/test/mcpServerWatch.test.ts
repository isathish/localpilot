import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { mcpWatchTargets, McpServerFileWatcher } from '../mcp/serverWatch';

suite('MCP server file watching (pure)', () => {
  const root = path.resolve(os.tmpdir(), 'lp-ws');

  test('picks workspace scripts and build/dist files of stdio servers only', () => {
    assert.deepStrictEqual(mcpWatchTargets({ command: 'node', args: ['server.js'] }, [root]), [path.join(root, 'server.js')]);
    assert.deepStrictEqual(mcpWatchTargets({ command: 'node', args: ['build/index'] }, [root]), [path.join(root, 'build', 'index')]);
    assert.deepStrictEqual(mcpWatchTargets({ command: 'python', args: ['-u', 'srv/main.py', '--port=1'] }, [root]), [path.join(root, 'srv', 'main.py')]);
    assert.deepStrictEqual(mcpWatchTargets({ command: path.join(root, 'dist', 'cli.mjs') }, [root]), [path.join(root, 'dist', 'cli.mjs')]);
    // Relative to the server's own cwd when it has one.
    assert.deepStrictEqual(mcpWatchTargets({ command: 'node', args: ['index.cjs'], cwd: path.join(root, 'tools') }, [root]), [path.join(root, 'tools', 'index.cjs')]);
  });

  test('ignores packages, files outside the workspace, references and remote servers', () => {
    assert.deepStrictEqual(mcpWatchTargets({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] }, [root]), []);
    assert.deepStrictEqual(mcpWatchTargets({ command: 'node', args: [path.resolve(os.tmpdir(), 'elsewhere', 'server.js')] }, [root]), []);
    assert.deepStrictEqual(mcpWatchTargets({ command: 'node', args: ['node_modules/pkg/dist/index.js'] }, [root]), []);
    assert.deepStrictEqual(mcpWatchTargets({ command: 'node', args: ['${env:SERVER}/index.js'] }, [root]), []);
    assert.deepStrictEqual(mcpWatchTargets({ url: 'https://x.dev/server.js' }, [root]), []);
    assert.deepStrictEqual(mcpWatchTargets({ command: 'node', args: ['server.js'] }, []), []);
  });

  test('a change restarts once after the debounce; unwatched servers stay quiet', async function () {
    this.timeout(10_000);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mcp-watch-'));
    const file = path.join(dir, 'server.js');
    const other = path.join(dir, 'notes.txt');
    await fs.writeFile(file, '// v1');
    await fs.writeFile(other, 'x');
    const hits: string[] = [];
    const w = new McpServerFileWatcher((name, f) => hits.push(`${name}:${path.basename(f)}`), 400);
    try {
      w.watch('dev', [file, path.join(dir, 'missing.js')]);
      assert.deepStrictEqual(w.watched, ['dev']);
      await new Promise((r) => setTimeout(r, 100));
      await fs.writeFile(other, 'y');
      await fs.writeFile(file, '// v2');
      await fs.writeFile(file, '// v3');
      await new Promise((r) => setTimeout(r, 1200));
      assert.deepStrictEqual(hits, ['dev:server.js'], 'a burst of saves restarts once; other files are ignored');
      w.unwatch('dev');
      await fs.writeFile(file, '// v4');
      await new Promise((r) => setTimeout(r, 800));
      assert.strictEqual(hits.length, 1);
      w.watch('none', []);
      assert.deepStrictEqual(w.watched, []);
    } finally {
      w.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('a script that is not built yet is watched: creating it restarts once', async function () {
    this.timeout(10_000);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mcp-watch-'));
    const file = path.join(dir, 'index.js');
    const hits: string[] = [];
    const w = new McpServerFileWatcher((name, f) => hits.push(`${name}:${path.basename(f)}`), 400);
    try {
      w.watch('dev', [file]);
      assert.deepStrictEqual(w.watched, ['dev']);
      await new Promise((r) => setTimeout(r, 100));
      await fs.writeFile(file, '// built');
      await new Promise((r) => setTimeout(r, 1200));
      assert.deepStrictEqual(hits, ['dev:index.js']);
      // A missing dist/ folder is watched from its parent; once built, the file itself is watched.
      const built = path.join(dir, 'dist', 'server.js');
      w.watch('dist', [built]);
      await new Promise((r) => setTimeout(r, 100));
      await fs.mkdir(path.dirname(built));
      await fs.writeFile(built, '// v1');
      await new Promise((r) => setTimeout(r, 1200));
      assert.deepStrictEqual(hits, ['dev:index.js', 'dist:server.js']);
      await fs.writeFile(built, '// v2');
      await new Promise((r) => setTimeout(r, 1200));
      assert.deepStrictEqual(hits, ['dev:index.js', 'dist:server.js', 'dist:server.js']);
    } finally {
      w.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
