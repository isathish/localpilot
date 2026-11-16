import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { mcpWatchTargets, McpServerFileWatcher } from '../mcp/serverWatch';
import { sleep, waitFor } from './waitFor';

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

  // Debounce of the watcher under test, and how long a quiet period must last to show that nothing else fires.
  const DEBOUNCE = 200;
  const QUIET = DEBOUNCE * 3;

  test('a change restarts once after the debounce; unwatched servers stay quiet', async function () {
    this.timeout(20_000);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mcp-watch-'));
    const file = path.join(dir, 'server.js');
    const other = path.join(dir, 'notes.txt');
    await fs.writeFile(file, '// v1');
    await fs.writeFile(other, 'x');
    const hits: string[] = [];
    const w = new McpServerFileWatcher((name, f) => hits.push(`${name}:${path.basename(f)}`), DEBOUNCE);
    try {
      w.watch('dev', [file, path.join(dir, 'missing.js')]);
      assert.deepStrictEqual(w.watched, ['dev']);
      // Some platforms (macOS FSEvents) can still report the writes above once the watch starts; let them pass first.
      await sleep(QUIET);
      hits.length = 0;
      await fs.writeFile(other, 'y');
      await sleep(QUIET);
      assert.deepStrictEqual(hits, [], 'files other than the server script are ignored');
      await fs.writeFile(file, '// v2');
      await fs.writeFile(file, '// v3');
      await waitFor(() => hits.length > 0, 10_000, 'the restart after saving the server script');
      await sleep(QUIET);
      assert.deepStrictEqual(hits, ['dev:server.js'], 'a burst of saves restarts once');
      w.unwatch('dev');
      await fs.writeFile(file, '// v4');
      await sleep(QUIET);
      assert.strictEqual(hits.length, 1, 'no restart after unwatch');
      w.watch('none', []);
      assert.deepStrictEqual(w.watched, []);
    } finally {
      w.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('a script that is not built yet is watched: creating it restarts once', async function () {
    this.timeout(30_000);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mcp-watch-'));
    const file = path.join(dir, 'index.js');
    const hits: string[] = [];
    const w = new McpServerFileWatcher((name, f) => hits.push(`${name}:${path.basename(f)}`), DEBOUNCE);
    const count = (h: string) => hits.filter((x) => x === h).length;
    /**
     * A file watcher can miss events in the first moments after it starts (macOS FSEvents) and gives no "ready"
     * signal, so instead of sleeping a fixed time the change is repeated until the restart is seen.
     */
    const eventually = async (change: (attempt: number) => Promise<void>, seen: () => boolean, what: string) => {
      for (let attempt = 0; attempt < 8 && !seen(); attempt++) {
        await change(attempt);
        await waitFor(seen, DEBOUNCE * 5, what).catch(() => undefined);
      }
      assert.ok(seen(), `timed out waiting for ${what}`);
    };
    try {
      w.watch('dev', [file]);
      assert.deepStrictEqual(w.watched, ['dev']);
      await eventually((n) => fs.writeFile(file, `// built ${'x'.repeat(n)}`), () => count('dev:index.js') > 0, 'the restart after the script was created');
      // A missing dist/ folder is watched from its parent; once built, the file itself is watched.
      const built = path.join(dir, 'dist', 'server.js');
      w.watch('dist', [built]);
      await eventually(
        async () => {
          await fs.rm(path.dirname(built), { recursive: true, force: true });
          await fs.mkdir(path.dirname(built));
          await fs.writeFile(built, '// v1');
        },
        () => count('dist:server.js') > 0,
        'the restart after dist/server.js was created'
      );
      // After the restart the watch moves onto dist/ itself; a later save is seen too.
      const before = count('dist:server.js');
      await eventually((n) => fs.writeFile(built, `// v2 ${'x'.repeat(n)}`), () => count('dist:server.js') > before, 'a restart after saving dist/server.js again');
      assert.ok(hits.every((h) => h === 'dev:index.js' || h === 'dist:server.js'), `only the watched servers restart: ${hits.join(', ')}`);
    } finally {
      w.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
