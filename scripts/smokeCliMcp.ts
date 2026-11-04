/**
 * Smoke checks (bundled into scripts/smoke.ts) for `localpilot mcp`: argument parsing, the entry `add` writes, and
 * add / list / disable / enable / remove / auth against temporary user and project server files.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildMcpEntry, cmdMcp, McpCmdOptions, parseMcpArgs } from '../src/cli/mcpCmd';

type Check = (name: string, cond: boolean, detail?: unknown) => void;
const plain = { bold: (s: string) => s, dim: (s: string) => s, red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s, amber: (s: string) => s, cyan: (s: string) => s };

export async function cliMcp(check: Check): Promise<void> {
  console.log('\n[CLI mcp subcommand]');
  const p = parseMcpArgs(['add', 'fs', '--env', 'A=1', '-s', 'project', '--', 'npx', '-y', '@scope/server', '--root', '.']);
  check('mcp: add parses name, env, scope and the command after --', p.action === 'add' && p.name === 'fs' && p.env.A === '1' && p.scope === 'project' && p.target.join(' ') === 'npx -y @scope/server --root .', p);
  const r = parseMcpArgs(['add', 'gh', 'https://example.com/mcp', '--transport=sse', '--header', 'Authorization: Bearer ${env:T}']);
  check('mcp: add parses a URL, --transport= and a header', r.target[0] === 'https://example.com/mcp' && r.transport === 'sse' && r.headers.Authorization === 'Bearer ${env:T}', r);
  check('mcp: no arguments is the menu, list --json is a list', parseMcpArgs([]).action === 'menu' && parseMcpArgs(['list', '--json']).json && parseMcpArgs(['--json']).action === 'list');
  check('mcp: usage errors', !!parseMcpArgs(['remove']).error && !!parseMcpArgs(['frob']).error && !!parseMcpArgs(['add', 'x', '--transport', 'ws']).error && !!parseMcpArgs(['enable', 'a b/c']).error && !!parseMcpArgs(['add', 'x', '--wat']).error);
  check('mcp: stdio entry', JSON.stringify(buildMcpEntry(p).entry) === JSON.stringify({ command: 'npx', args: ['-y', '@scope/server', '--root', '.'], env: { A: '1' } }), buildMcpEntry(p));
  check('mcp: remote entry', JSON.stringify(buildMcpEntry(r).entry) === JSON.stringify({ type: 'sse', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${env:T}' } }), buildMcpEntry(r));
  check('mcp: mismatched flags are refused', !!buildMcpEntry({ target: ['https://x.dev/mcp'], env: { A: '1' }, headers: {} }).error && !!buildMcpEntry({ target: ['node', 's.js'], transport: 'http', env: {}, headers: {} }).error && !!buildMcpEntry({ target: [], env: {}, headers: {} }).error);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cli-mcp-'));
  const userFile = path.join(dir, 'home', 'mcp.json');
  const cwd = path.join(dir, 'repo');
  fs.mkdirSync(cwd, { recursive: true });
  const lines: string[] = [];
  const errs: string[] = [];
  let authed = '';
  const o: McpCmdOptions = { cwd, st: plain, userFile, out: (s) => lines.push(s), err: (s) => errs.push(s), authenticate: async (name, cfg) => ((authed = `${name} ${cfg.url}`), 'signed in') };
  const run = (...argv: string[]) => cmdMcp(parseMcpArgs(argv), o);
  try {
    check('mcp add (user) writes ~/.localpilot/mcp.json', (await run('add', 'lp-smoke-a', '--', 'node', 'server.js')) === 0 && JSON.parse(fs.readFileSync(userFile, 'utf8')).mcpServers['lp-smoke-a'].command === 'node');
    const dup = await run('add', 'lp-smoke-a', '--', 'node', 'x.js').then(() => '', (e) => String(e));
    check('mcp add of an existing name needs --force', /already defined/.test(dup), dup);
    check('mcp add --force replaces it', (await run('add', 'lp-smoke-a', '--force', '--', 'node', 'y.js')) === 0 && JSON.parse(fs.readFileSync(userFile, 'utf8')).mcpServers['lp-smoke-a'].args[0] === 'y.js');
    check('mcp add --scope project writes ./.mcp.json', (await run('add', 'lp-smoke-r', 'https://example.com/mcp', '--scope', 'project')) === 0 && !!JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8')).mcpServers['lp-smoke-r'].url);
    lines.length = 0;
    await run('list', '--json');
    const listed = JSON.parse(lines.join('\n')) as { servers: { name: string; source: string; enabled: boolean }[] };
    check('mcp list --json shows both with their source', listed.servers.some((s) => s.name === 'lp-smoke-a' && s.source === 'user') && listed.servers.some((s) => s.name === 'lp-smoke-r' && s.source === 'project'), listed);
    await run('disable', 'lp-smoke-r');
    check('mcp disable writes "disabled" in the file it came from', JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8')).mcpServers['lp-smoke-r'].disabled === true);
    await run('enable', 'lp-smoke-r');
    check('mcp enable clears it', JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8')).mcpServers['lp-smoke-r'].disabled === undefined);
    check('mcp auth connects to a remote server', (await run('auth', 'lp-smoke-r')) === 0 && authed === 'lp-smoke-r https://example.com/mcp', authed);
    check('mcp auth refuses a local server', (await run('auth', 'lp-smoke-a')) === 1);
    check('mcp remove deletes it', (await run('remove', 'lp-smoke-a')) === 0 && !('lp-smoke-a' in JSON.parse(fs.readFileSync(userFile, 'utf8')).mcpServers));
    check('mcp remove of an unknown name fails', (await run('remove', 'lp-smoke-none')) === 1);
    fs.writeFileSync(userFile, '{\n  // mine\n  "mcpServers": {}\n}\n');
    let refused = false;
    await run('add', 'lp-smoke-c', '--', 'node', 'c.js').catch((e) => (refused = /comments/.test(String(e))));
    check('mcp add refuses to drop comments', refused && fs.readFileSync(userFile, 'utf8').includes('// mine'));
    check('mcp leaves no temporary files', !fs.readdirSync(path.dirname(userFile)).some((f) => f.endsWith('.tmp')) && !fs.readdirSync(cwd).some((f) => f.endsWith('.tmp')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
