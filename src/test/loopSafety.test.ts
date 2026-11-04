import * as assert from 'assert';
import { localToolNames } from '../agent/builtinAgents';
import { MistakeCounter, mistakeLimitMessage, mistakeReason } from '../agent/mistakes';
import { hasUnterminatedToolCall, joinContinuation, lengthAction, MAX_LENGTH_RETRIES } from '../agent/outputLimit';
import { mapToolNames, toolDisabled } from '../agent/toolAliases';

suite('Agent loop safety: mistake limit, output cut-offs, tool names', () => {
  test('the mistake counter stops at the limit and resets on any success', () => {
    const m = new MistakeCounter(3);
    assert.strictEqual(m.recordStep([{ isError: true, content: 'File not found: a.ts' }]), false);
    assert.strictEqual(m.recordStep([{ isError: true, content: 'x' }, { isError: false, content: 'ok' }]), false, 'one success in the step resets');
    assert.strictEqual(m.count, 0);
    m.recordStep([{ isError: true, content: 'a' }]);
    m.recordRepair('unexpected end of JSON');
    assert.strictEqual(m.recordStep([{ isError: true, content: '<tool_result name="read_file">\nFile not found: b.ts\n</tool_result>' }]), true);
    assert.strictEqual(m.latest, 'File not found: b.ts', 'the text-protocol wrapper is stripped');
    assert.strictEqual(m.recordStep([]), false, 'a step without tool calls changes nothing');
    assert.strictEqual(m.count, 3);
    assert.match(mistakeLimitMessage(m.count, m.latest), /^LocalPilot ran into 3 errors in a row and stopped\. Latest: File not found: b\.ts\. Send a message/);
  });

  test('a limit of 0 never stops; long reasons are shortened', () => {
    const m = new MistakeCounter(0);
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(m.recordStep([{ isError: true, content: 'boom' }]), false);
    }
    assert.ok(mistakeReason('x'.repeat(500)).length <= 200);
  });

  test('output cut-off: cut-off calls retry up to the limit, prose continues once', () => {
    const base = { finish: 'length', truncatedCall: true, text: '', retries: 0, continuing: false };
    assert.strictEqual(lengthAction({ ...base, finish: 'stop' }), 'none');
    assert.strictEqual(lengthAction(base), 'retry');
    assert.strictEqual(lengthAction({ ...base, retries: MAX_LENGTH_RETRIES - 1 }), 'retry');
    assert.strictEqual(lengthAction({ ...base, retries: MAX_LENGTH_RETRIES }), 'give_up');
    assert.strictEqual(lengthAction({ ...base, truncatedCall: false, text: 'Here is the long explanation' }), 'continue');
    assert.strictEqual(lengthAction({ ...base, truncatedCall: false, text: 'more', continuing: true }), 'none', 'a continuation is not continued again');
    assert.strictEqual(lengthAction({ ...base, truncatedCall: false, text: '  ' }), 'none');
  });

  test('a text-protocol call cut off before it ends is detected', () => {
    const known = new Set(['write_file']);
    assert.ok(hasUnterminatedToolCall('<tool_call>\n{"name":"write_file","arguments":{"path":"a","content":"abc', known), 'open tag');
    assert.ok(hasUnterminatedToolCall('```json\n{"name": "write_file", "arguments": {"path": "a"', known), 'unclosed fence');
    assert.ok(hasUnterminatedToolCall('Writing: {"name":"write_file","arguments":{"path":"a","content":"x}', known), 'bare JSON');
    assert.ok(!hasUnterminatedToolCall('<tool_call>{"name":"write_file","arguments":{}}</tool_call> then ```js\nconst a = 1;', known));
    assert.ok(!hasUnterminatedToolCall('{"name":"Ada","age": 3', known), 'unknown names are prose');
  });

  test('a continuation is joined without repeating the overlap', () => {
    assert.strictEqual(joinContinuation('The quick brown fox jumps', ' over the lazy dog.'), 'The quick brown fox jumps over the lazy dog.');
    assert.strictEqual(joinContinuation('The quick brown fox jumps', 'brown fox jumps over the lazy dog.'), 'The quick brown fox jumps over the lazy dog.');
    assert.strictEqual(joinContinuation('', 'all new'), 'all new');
  });

  test('Claude Code and Cline tool names map to LocalPilot tools', () => {
    assert.deepStrictEqual(mapToolNames(['Read', 'Grep']), ['read_file', 'grep_search']);
    assert.deepStrictEqual(mapToolNames(['Glob', 'Edit', 'MultiEdit', 'Write', 'Bash(git:*)', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead', 'Task']), ['file_search', 'edit_file', 'write_file', 'run_command', 'list_dir', 'web_fetch', 'web_search', 'read_file', 'run_subagent']);
    assert.deepStrictEqual(mapToolNames(['read_files', 'editor', 'run_commands', 'search_codebase']), ['read_file', 'edit_file', 'write_file', 'run_command', 'grep_search', 'file_search']);
    assert.deepStrictEqual(mapToolNames(['read_file', 'mcp__github__get_issue', 'custom_tool']), ['read_file', 'mcp_github__get_issue', 'custom_tool']);
    const agent = localToolNames(['Read', 'Grep']);
    assert.ok(agent.includes('read_file') && agent.includes('grep_search'), agent.join());
    assert.ok(!agent.includes('edit_file') && !agent.includes('NotebookRead'));
    assert.ok(localToolNames(['NotebookRead']).includes('read_file'));
  });

  test('disabledTools: exact names, foreign names and globs', () => {
    assert.ok(toolDisabled('web_fetch', ['web_fetch']));
    assert.ok(toolDisabled('run_command', ['Bash']));
    assert.ok(toolDisabled('run_command', ['execute_command']));
    assert.ok(toolDisabled('mcp_github_get_issue', ['mcp_*']));
    assert.ok(toolDisabled('browser_screenshot', ['browser_*']));
    assert.ok(!toolDisabled('read_file', ['mcp_*', 'browser_*', 'Bash', ' ']));
    assert.ok(!toolDisabled('open_file', ['Read']), 'a Claude name switches off only its direct tool');
  });
});
