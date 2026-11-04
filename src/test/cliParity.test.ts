import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { completeCommand, completionToken, createCompleter, listWorkspaceFiles } from '../cli/completer';
import { exitSummary, formatCost, nextMode, statusLineText, sumNumstat } from '../cli/statusLine';
import { eventRecord, NdjsonWriter, runUsage } from '../cli/ndjson';
import { atRefs, exitCodeFor, finishReasonFor, parseDuration, readSystemArg, runProviderList, withStdin, YOLO_TOOLS } from '../cli/headless';
import { compareVersions, extensionVersion, newestInstalledExtension, versionNotice } from '../cli/versionCheck';
import { parseSettingValue, redactSecrets, settingKey, settingsRows } from '../cli/settingsView';
import { contextPercent, contextReport, memoryReport } from '../agent/reports';
import { CONFIG_KINDS, formatConfigItems } from '../cli/configCmd';
import { ProviderConfig } from '../types';

const plain = { bold: (s: string) => s, dim: (s: string) => s, red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s, amber: (s: string) => s, cyan: (s: string) => s };

function tmpTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cli-parity-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

suite('CLI parity: REPL completion and status line', () => {
  test('completion tokens: /commands at the start, @paths anywhere', () => {
    assert.deepStrictEqual(completionToken('/com'), { kind: 'command', token: '/com' });
    assert.deepStrictEqual(completionToken('look at @src/ma'), { kind: 'path', token: '@src/ma' });
    assert.strictEqual(completionToken('plain words'), undefined);
    assert.strictEqual(completionToken('a /cmd later'), undefined);
    assert.deepStrictEqual(completeCommand('/co', ['/compact', '/context', '/clear', '/compact']), ['/compact', '/context']);
  });

  test('@path completion walks the workspace and skips node_modules and .git', () => {
    const root = tmpTree({ 'src/main.ts': '', 'src/util/math.ts': '', 'node_modules/x/index.js': '', '.git/HEAD': '', 'README.md': '' });
    try {
      const files = listWorkspaceFiles(root);
      assert.ok(files.includes('src/main.ts') && files.includes('src/util/math.ts') && files.includes('README.md'));
      assert.ok(!files.some((f) => f.startsWith('node_modules') || f.startsWith('.git')));
      const complete = createCompleter({ commands: () => ['/help', '/history'], root: () => root });
      const [hits, token] = complete('explain @math');
      assert.strictEqual(token, '@math');
      assert.strictEqual(hits[0], '@src/util/math.ts');
      assert.deepStrictEqual(complete('/hi')[0], ['/history']);
      assert.deepStrictEqual(complete('see @./sr')[0], ['@./src/']);
      // Shift+Tab: no completion at all.
      assert.deepStrictEqual(createCompleter({ commands: () => ['/help'], root: () => root, skip: () => true })('/he'), [[], '/he']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('status line, mode cycle and exit summary', () => {
    assert.strictEqual(statusLineText({ model: 'ollama/qwen', mode: 'agent', ctxPercent: 34, git: { branch: 'main', added: 3, removed: 1 }, auto: false, costUsd: 0.021 }), 'ollama/qwen · agent · ctx 34% · main +3 −1 · auto:off · $0.02');
    assert.strictEqual(statusLineText({ model: 'm', mode: 'plan', auto: true }), 'm · plan · auto:on');
    assert.strictEqual(formatCost(0.001), '<$0.01');
    assert.deepStrictEqual(sumNumstat('3\t1\ta.ts\n-\t-\timg.png\n10\t0\tb.ts\n'), { added: 13, removed: 1 });
    assert.strictEqual(nextMode('agent'), 'multitask');
    assert.strictEqual(nextMode('ask'), 'agent');
    const s = exitSummary({ id: 'cli-abc', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }], usage: { promptTokens: 100, completionTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1, costUsd: 0.5 } }, plain);
    assert.ok(/session cli-abc · 2 messages · 120 tokens · \$0\.50/.test(s) && /localpilot -r cli-abc/.test(s), s);
    assert.strictEqual(exitSummary({ id: 'x', messages: [] }, plain), 'bye');
  });

  test('/memory and /context texts are shared with the chat', () => {
    assert.ok(/No instruction files found/.test(memoryReport([], [], true)));
    assert.ok(/are off/.test(memoryReport([], [], false)));
    const notes = [{ name: 'build', scope: 'project' as const, summary: 'npm run build', updatedAt: 0, chars: 20 }];
    assert.ok(/\.localpilot\/memory/.test(memoryReport([], notes, true, 'cli')) && /Settings → Memory/.test(memoryReport([], notes, true)));
    assert.strictEqual(contextReport({ contextTokens: 1000, messages: [], compactions: 1, model: 'm' }, { contextWindow: 8000 }, 4000), 'Context: ~1,000 of 4,000 (model supports 8,000; raise `localpilot.contextWindow` or set it to 0 for the model\'s maximum) tokens · 0 messages · 1 compactions · model m');
    assert.strictEqual(contextPercent(1000, 4000), 25);
    assert.strictEqual(contextPercent(1000, undefined), undefined);
  });

  test('/settings masks secrets and parses values', () => {
    const red = redactSecrets({ providers: [{ id: 'x', apiKey: 'sk-live', headers: { Authorization: 'Bearer t' } }, { id: 'y', apiKey: '${secret:y}' }] }) as { providers: { apiKey: string; headers?: { Authorization: string } }[] };
    assert.strictEqual(red.providers[0].apiKey, '••••');
    assert.strictEqual(red.providers[0].headers?.Authorization, '••••');
    assert.strictEqual(red.providers[1].apiKey, '${secret:y}');
    assert.deepStrictEqual(settingsRows({ thinking: 'high', 'approvals.terminal': 'ask' }, 'think'), ['thinking = "high"']);
    assert.strictEqual(parseSettingValue('true'), true);
    assert.deepStrictEqual(parseSettingValue('["a"]'), ['a']);
    assert.strictEqual(parseSettingValue('ollama/qwen'), 'ollama/qwen');
    assert.strictEqual(settingKey('localpilot.compaction.strategy'), 'compaction.strategy');
    assert.strictEqual(settingKey('bad key'), undefined);
  });
});

suite('CLI parity: headless runs', () => {
  test('exit codes and finish reasons', () => {
    assert.strictEqual(exitCodeFor({}), 0);
    assert.strictEqual(exitCodeFor({ error: 'boom' }), 1);
    assert.strictEqual(exitCodeFor({ error: 'x', errorKind: 'mistake_limit' }), 3);
    assert.strictEqual(exitCodeFor({ aborted: true, timedOut: true }), 124);
    assert.strictEqual(exitCodeFor({ aborted: true }), 130);
    assert.strictEqual(finishReasonFor({ completed: false }), 'max_steps');
    assert.strictEqual(finishReasonFor({ aborted: true, timedOut: true }), 'timeout');
    assert.strictEqual(finishReasonFor({ error: 'x', errorKind: 'mistake_limit' }), 'mistake_limit');
  });

  test('durations, stdin context, system prompt files', () => {
    assert.strictEqual(parseDuration('90'), 90_000);
    assert.strictEqual(parseDuration('5m'), 300_000);
    assert.strictEqual(parseDuration('0'), undefined);
    assert.strictEqual(parseDuration('soon'), undefined);
    assert.strictEqual(withStdin('review this', 'diff --git a b'), 'review this\n\n<stdin>\ndiff --git a b\n</stdin>');
    assert.strictEqual(withStdin('x', ''), 'x');
    const root = tmpTree({ 'sys.md': 'Be terse.' });
    try {
      assert.strictEqual(readSystemArg('@sys.md', root), 'Be terse.');
      assert.strictEqual(readSystemArg('inline text', root), 'inline text');
      assert.throws(() => readSystemArg('@missing.md', root));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('@refs: images go with the message, files are attached, other @words stay text', () => {
    const root = tmpTree({ 'shot.png': 'png', 'src/a.ts': 'x' });
    try {
      const r = atRefs('fix @./shot.png and @src/a.ts#L1-L2, ping @team.', root);
      assert.deepStrictEqual(r.images, [path.join(root, 'shot.png')]);
      assert.deepStrictEqual(r.files, [`${path.join(root, 'src/a.ts')}#L1-L2`]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('-P/-k: the provider for this run, with a key that stays in the process', () => {
    const list: ProviderConfig[] = [{ id: 'ollama', type: 'ollama', baseUrl: 'http://localhost:11434' }, { id: 'openai', type: 'openai', baseUrl: 'https://api.openai.com/v1', enabled: false }];
    const on = runProviderList(list, 'openai', undefined, '${secret:localpilot-run-openai}');
    assert.strictEqual(on.list.find((p) => p.id === 'openai')?.enabled, true);
    assert.strictEqual(on.list.find((p) => p.id === 'openai')?.apiKey, '${secret:localpilot-run-openai}');
    const added = runProviderList(list, 'groq', { id: 'groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', cloud: true });
    assert.strictEqual(added.list.length, 3);
    assert.ok(runProviderList(list, 'nope', undefined).error);
    assert.ok(YOLO_TOOLS.includes('run_command') && !YOLO_TOOLS.includes('web_fetch'));
  });

  test('NDJSON: one record per line, errors on stderr, a final run_result', () => {
    const out: string[] = [];
    const err: string[] = [];
    const w = new NdjsonWriter({ write: (s: string) => out.push(s) } as unknown as NodeJS.WritableStream, { write: (s: string) => err.push(s) } as unknown as NodeJS.WritableStream, () => 42);
    w.event({ sessionId: 's', type: 'assistant_delta', payload: 'Hel' });
    w.event({ sessionId: 's', type: 'tool_start', payload: { id: 'c1', name: 'read_file', args: { path: 'a' } } });
    w.event({ sessionId: 's', type: 'turn_end', payload: { text: 'x' } });
    w.event({ sessionId: 's', type: 'error', payload: { kind: 'mistake_limit', count: 3, message: 'stopped' } });
    w.result({ finishReason: 'mistake_limit', text: '', ...runUsage(undefined, { promptTokens: 10, completionTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 }), durationMs: 5, model: 'm', sessionId: 's' });
    const records = out.map((l) => JSON.parse(l));
    assert.ok(out.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n')));
    assert.deepStrictEqual(records.map((r) => r.type), ['assistant_delta', 'tool_start', 'run_result']);
    assert.deepStrictEqual(records[0], { type: 'assistant_delta', ts: 42, text: 'Hel' });
    assert.strictEqual(records[2].usage.promptTokens, 10);
    assert.deepStrictEqual(JSON.parse(err[0]), { kind: 'mistake_limit', count: 3, type: 'error', ts: 42, message: 'stopped' });
    assert.strictEqual(eventRecord({ sessionId: 's', type: 'todos', payload: [] }), undefined);
  });
});

suite('CLI parity: config listing and version notice', () => {
  test('config rows show source, state and approval', () => {
    assert.deepStrictEqual([...CONFIG_KINDS], ['rules', 'skills', 'agents', 'commands', 'hooks', 'mcp', 'tools', 'plugins']);
    const text = formatConfigItems('tools', [{ name: 'run_command', source: 'builtin', enabled: true, approval: 'terminal' }, { name: 'web_fetch', source: 'builtin', enabled: false, approval: 'network' }], plain);
    assert.ok(/run_command \(builtin, approval: terminal\)/.test(text) && /web_fetch \(builtin, approval: network, off\)/.test(text), text);
    assert.ok(/no hooks/.test(formatConfigItems('hooks', [], plain)));
  });

  test('extension versions: newest installed copy and the mismatch notice', () => {
    assert.strictEqual(extensionVersion('localpilot.localpilot-agent-1.6.0'), '1.6.0');
    assert.strictEqual(extensionVersion('localpilot.localpilot-agent-1.6.0-darwin-arm64'), '1.6.0');
    assert.strictEqual(extensionVersion('other.ext-1.0.0'), undefined);
    assert.ok(compareVersions('1.5.2', '1.10.0') < 0 && compareVersions('2.0.0', '1.9.9') > 0 && compareVersions('1.2.3', '1.2.3') === 0);
    const home = tmpTree({ '.vscode/extensions/localpilot.localpilot-agent-1.5.0/dist/cli.js': '', '.cursor/extensions/localpilot.localpilot-agent-1.7.1/dist/cli.js': '', '.vscode/extensions/localpilot.localpilot-agent-9.0.0/package.json': '{}' });
    try {
      const newest = newestInstalledExtension(home);
      assert.strictEqual(newest?.version, '1.7.1');
      assert.ok(versionNotice('1.6.0', newest)?.includes('v1.7.1'));
      assert.strictEqual(versionNotice('1.7.1', newest), undefined);
      assert.strictEqual(versionNotice('0.0.0', newest), undefined);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
