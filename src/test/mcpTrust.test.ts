import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { cliMcpTrust } from '../mcp/trust';

suite('CLI MCP trust', () => {
  let dir: string;
  let file: string;
  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mcptrust-'));
    file = path.join(dir, 'mcp-trust.json');
  });
  teardown(() => fs.rm(dir, { recursive: true, force: true }));

  const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      return await fn();
    } finally {
      process.stderr.write = write;
    }
  };

  test('with no terminal it never asks, starts nothing and saves nothing', async () => {
    let asked = 0;
    const trust = cliMcpTrust(dir, () => false, { file, interactive: () => false, prompt: async () => (asked++, 'y') });
    assert.strictEqual(await quietly(() => trust.ask(['s'], path.join(dir, '.mcp.json'), ['s:k'])), false);
    assert.strictEqual(asked, 0);
    await assert.rejects(fs.stat(file));
    assert.strictEqual(trust.isTrusted('s:k'), false);
  });

  test('only a typed yes trusts and remembers the keys', async () => {
    const answers = ['', 'Start', 'yes'];
    const trust = cliMcpTrust(dir, () => false, { file, interactive: () => true, prompt: async () => answers.shift() });
    assert.strictEqual(await quietly(() => trust.ask(['s'], '.mcp.json', ['s:k'])), false);
    assert.strictEqual(await quietly(() => trust.ask(['s'], '.mcp.json', ['s:k'])), false);
    await assert.rejects(fs.stat(file));
    assert.strictEqual(await trust.ask(['s'], '.mcp.json', ['s:k']), true);
    assert.deepStrictEqual(JSON.parse(await fs.readFile(file, 'utf8')), { [path.resolve(dir)]: ['s:k'] });
    assert.strictEqual(trust.isTrusted('s:k'), true);
    assert.strictEqual(cliMcpTrust(dir, () => true, { file, prompt: async () => undefined }).isTrusted('other'), true);
  });
});
