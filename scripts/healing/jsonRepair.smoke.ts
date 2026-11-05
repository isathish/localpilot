/**
 * Smoke checks for src/agent/healing/jsonRepair.ts (design §5.6).
 *   node scripts/healing/run.js scripts/healing/jsonRepair.smoke.ts
 */
import { MUTATING_TOOL_NAMES, isMutatingToolName, repairJson, repairToolCallText } from '../../src/agent/healing/jsonRepair';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

const REQUIRED: Record<string, string[]> = {
  read_file: ['path'],
  write_file: ['path', 'content'],
  grep: ['pattern'],
  run_command: ['command'],
  git_commit: ['message'],
  mcp_db_query: ['sql'],
};
const READ_ONLY = new Set(['read_file', 'grep']);
const TYPES: Record<string, Record<string, string>> = {
  read_file: { path: 'string', startLine: 'integer', endLine: 'integer' },
  grep: { pattern: 'string' },
};
const opts = (finish?: string) => ({
  knownToolNames: new Set(Object.keys(REQUIRED)),
  finish,
  requiredParams: (t: string) => REQUIRED[t] ?? [],
  paramTypes: (t: string) => TYPES[t],
  isReadOnly: (t: string) => READ_ONLY.has(t),
});

export async function jsonRepairSmoke(check: Check): Promise<void> {
  const strict = repairJson('{"a":1}');
  check('strict JSON passes untouched', strict.ok && strict.fixes.length === 0 && !strict.truncated, strict);

  const comma = repairJson('{"a": [1, 2,], "b": 3,}');
  check('trailing commas removed', comma.ok && JSON.stringify(comma.value) === '{"a":[1,2],"b":3}' && comma.fixes.includes('trailing_comma'), comma);

  const nl = repairJson('{"content": "line one\nline two\tend"}');
  check('raw newline/tab in a string escaped', nl.ok && (nl.value as { content: string }).content === 'line one\nline two\tend' && nl.fixes.includes('control_chars'), nl);

  const sq = repairJson("{'path': 'src/it\\'s.ts', 'note': 'don't panic'}");
  check(
    'single quotes converted (escaped and unambiguous apostrophes kept)',
    sq.ok && JSON.stringify(sq.value) === JSON.stringify({ path: "src/it's.ts", note: "don't panic" }) && sq.fixes.includes('single_quotes'),
    sq,
  );

  const smart = repairJson('{“path”: “a.ts”, "q": "he said “hi”"}');
  check('smart quotes as delimiters fixed, inside strings kept', smart.ok && JSON.stringify(smart.value) === JSON.stringify({ path: 'a.ts', q: 'he said “hi”' }), smart);

  const bare = repairJson('{path: "a.ts", recursive: true, limit: 5}');
  check('bare keys quoted, literals kept', bare.ok && JSON.stringify(bare.value) === '{"path":"a.ts","recursive":true,"limit":5}' && bare.fixes.includes('bare_keys'), bare);

  const fenced = repairJson('Sure, here is the config:\n```json\n{"a": 1, "b": "x",}\n```\nLet me know!');
  check('prose + fence stripped', fenced.ok && JSON.stringify(fenced.value) === '{"a":1,"b":"x"}' && fenced.fixes.includes('fence'), fenced);

  const noTrunc = repairJson('{"a": {"b": "c"');
  check('truncation not repaired without allowTruncation', !noTrunc.ok && noTrunc.truncated, noTrunc);
  const trunc = repairJson('{"a": {"b": "c", "d"', { allowTruncation: true });
  check('truncation: dangling key dropped, braces balanced', trunc.ok && JSON.stringify(trunc.value) === '{"a":{"b":"c"}}' && trunc.fixes.includes('truncation'), trunc);
  const truncNum = repairJson('{"a": "x", "n": 12', { allowTruncation: true });
  check('truncation: possibly cut number dropped, never invented', truncNum.ok && JSON.stringify(truncNum.value) === '{"a":"x"}', truncNum);
  const midString = repairJson('{"name": "read_file", "arguments": {"path": "src/ag', { allowTruncation: true });
  check('truncated mid-string -> ok false', !midString.ok && midString.truncated, midString);
  const braceInString = repairJson('{"a": "{[", "b": [1', { allowTruncation: true });
  check('balancing is string-aware', braceInString.ok && JSON.stringify(braceInString.value) === '{"a":"{[","b":[]}', braceInString);

  check(
    'mutating tool denylist',
    ['write_file', 'edit_file', 'apply_patch', 'run_command', 'notebook_edit', 'delete_path', 'git_commit', 'git_push', 'pull_request', 'create_directory', 'schedule', 'team_board'].every((t) =>
      MUTATING_TOOL_NAMES.includes(t),
    ) && isMutatingToolName('mcp_anything') && !isMutatingToolName('read_file'),
  );

  const tc = repairToolCallText('I will read it.\n```tool_call\n{"name": "read_file", "arguments": {"path": "a.ts",},}\n```', opts('stop'));
  check(
    'tool call: trailing comma repaired',
    tc?.name === 'read_file' && tc.argumentsJson === '{"path":"a.ts"}' && tc.text.startsWith('I will read it.\n```tool_call\n{"name":"read_file"') && !tc.truncated,
    tc,
  );

  const truncRead = repairToolCallText('<tool_call>{"name": "read_file", "arguments": {"path": "src/a.ts", "startLine": 1, "endLine"', opts('stop'));
  check('truncated read_file object repaired', truncRead?.name === 'read_file' && truncRead.argumentsJson === '{"path":"src/a.ts","startLine":1}' && truncRead.truncated, truncRead);

  const truncWrite = repairToolCallText('```tool_call\n{"name": "write_file", "arguments": {"path": "a.ts", "content": "x = 1\\n"', opts('stop'));
  check('truncated write_file object -> undefined', truncWrite === undefined, truncWrite);
  const truncCmd = repairToolCallText('{"name": "run_command", "arguments": {"command": "ls"', opts());
  check('truncated run_command object -> undefined', truncCmd === undefined, truncCmd);

  const truncCommit = repairToolCallText('<tool_call>{"name": "git_commit", "arguments": {"message": "wip", "paths": ["a.ts", "b.ts"', opts('stop'));
  check('truncated git_commit (partial paths) -> undefined', truncCommit === undefined, truncCommit);
  const truncCommitKey = repairToolCallText('<tool_call>{"name": "git_commit", "arguments": {"message": "wip", "paths"', opts('stop'));
  check('truncated git_commit (dropped key) -> undefined', truncCommitKey === undefined, truncCommitKey);
  const truncMcp = repairToolCallText('<tool_call>{"name": "mcp_db_query", "arguments": {"sql": "DELETE FROM t", "limit": 1', opts('stop'));
  check('truncated mcp_* call -> undefined', truncMcp === undefined, truncMcp);
  const noPredicate = repairToolCallText('<tool_call>{"name": "read_file", "arguments": {"path": "src/a.ts", "startLine": 1, "endLine"', {
    ...opts('stop'),
    isReadOnly: undefined,
  });
  check('truncation never repaired without an isReadOnly predicate', noPredicate === undefined, noPredicate);
  const commitOk = repairToolCallText('<tool_call>{"name": "git_commit", "arguments": {"message": "wip",}}</tool_call>', opts('stop'));
  check('complete mutating call: trailing comma still repaired', commitOk?.name === 'git_commit' && commitOk.argumentsJson === '{"message":"wip"}', commitOk);

  const lengthCut = repairToolCallText('```tool_call\n{"name": "read_file", "arguments": {"path": "a.ts",}}\n```', opts('length'));
  check("finish 'length' -> undefined", lengthCut === undefined, lengthCut);

  const missing = repairToolCallText('<tool_call>{"name": "write_file", "arguments": {"path": "a.ts",}}</tool_call>', opts('stop'));
  check('missing required arg -> undefined', missing === undefined, missing);
  const truncMissing = repairToolCallText('<tool_call>{"name": "read_file", "arguments": {"pa', opts('stop'));
  check('truncated before the required arg -> undefined', truncMissing === undefined, truncMissing);
  const wrongType = repairToolCallText("{'name': 'read_file', 'arguments': {'path': 'a.ts', 'startLine': 'one'}}", opts('stop'));
  check('wrong primitive type -> undefined', wrongType === undefined, wrongType);
  const unknown = repairToolCallText('<tool_call>{"name": "launch_rocket", "arguments": {},}</tool_call>', opts('stop'));
  check('unknown tool -> undefined', unknown === undefined, unknown);

  const bareCall = repairToolCallText('Searching.\n```json\n{name: "grep", arguments: "{\\"pattern\\": \\"TODO\\",}"}\n```\nDone.', opts('stop'));
  check(
    'bare call in a json fence: bare keys + string arguments repaired, fence replaced',
    bareCall?.name === 'grep' && bareCall.argumentsJson === '{"pattern":"TODO"}' && bareCall.text === 'Searching.\n```tool_call\n{"name":"grep","arguments":{"pattern":"TODO"}}\n```\nDone.',
    bareCall,
  );
  const pkgFirst = repairToolCallText(
    'Example:\n```json\n{"name": "my-pkg", "version": "1.0.0"}\n```\nNow:\n```tool_call\n{"name": "read_file", "arguments": {"path": "a.ts",}}\n```',
    opts('stop'),
  );
  check(
    'non-tool {"name": …} JSON before a malformed tool_call: real call repaired',
    pkgFirst?.name === 'read_file' &&
      pkgFirst.argumentsJson === '{"path":"a.ts"}' &&
      pkgFirst.text.startsWith('Example:\n```json\n{"name": "my-pkg"') &&
      pkgFirst.text.endsWith('Now:\n```tool_call\n{"name":"read_file","arguments":{"path":"a.ts"}}\n```'),
    pkgFirst,
  );
  const bareAfterPkg = repairToolCallText('{"name": "my-pkg", "version": "1.0.0"}\nthen {"name": "grep", "arguments": {"pattern": "x",}}', opts('stop'));
  check('second bare candidate tried after an unknown-name one', bareAfterPkg?.name === 'grep' && bareAfterPkg.argumentsJson === '{"pattern":"x"}', bareAfterPkg);
  check('no tool call -> undefined', repairToolCallText('Just prose, nothing to call.', opts('stop')) === undefined);
}
