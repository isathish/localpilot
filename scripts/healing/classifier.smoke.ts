/**
 * Smoke checks for the Error Classifier, toolchain parsers and failure signatures (design §3, LP-REC-002).
 *   node scripts/healing/run.js scripts/healing/classifier.smoke.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { classify, groupFailures, type ClassifyInput } from '../../src/agent/healing/classifier';
import { exactSignature, genericSignature, humanKey, normaliseMessage } from '../../src/agent/healing/signature';
import { defaultClass } from '../../src/agent/healing/parsers/common';
import { DEFAULT_POLICIES, effectivePolicies } from '../../src/agent/healing/policy';
import { decide } from '../../src/agent/healing/retryController';
import type { CheckEcosystem, CheckKind, Failure, FailureCategory, RecoveryState } from '../../src/agent/healing/types';
import { ModelStallError } from '../../src/agent/resilience';
import { HttpError } from '../../src/providers/http';

declare const REPO_ROOT: string;
type Check = (name: string, cond: boolean, detail?: unknown) => void;

interface Expected {
  category: string;
  code?: string | null;
  file?: string | null;
  line?: number | null;
  test?: string;
  symbol?: string;
  cls?: string;
}
interface Fixture {
  input: 'check' | 'run_command';
  ecosystem?: CheckEcosystem;
  kind?: CheckKind;
  command?: string;
  exitCode?: number;
  root: string;
  expected: Expected[];
}

const HEX16 = /^[0-9a-f]{16}$/;

function runFixture(fx: Fixture, text: string, root = fx.root): Failure[] {
  if (fx.input === 'check') {
    return classify({ kind: 'check', spec: { id: `fixture:${fx.kind}`, kind: fx.kind ?? 'custom', ecosystem: fx.ecosystem ?? 'custom' }, outcome: { exitCode: fx.exitCode ?? 1, output: text }, root });
  }
  const exitCode = fx.exitCode ?? 1;
  return classify({
    kind: 'tool',
    name: 'run_command',
    args: { command: fx.command ?? 'make' },
    result: { content: `$ ${fx.command ?? 'make'}\n${text}\n[exit code ${exitCode}]`, isError: exitCode !== 0, data: { exitCode } },
    root,
  });
}

function matches(f: Failure, e: Expected): boolean {
  return f.category === e.category
    && (e.code === undefined || (f.code ?? null) === e.code)
    && (e.file === undefined || (f.file ?? null) === e.file)
    && (e.line === undefined || (f.line ?? null) === e.line)
    && (e.test === undefined || f.test === e.test)
    && (e.symbol === undefined || f.symbol === e.symbol)
    && (e.cls === undefined || f.cls === e.cls);
}

const brief = (fs: Failure[]) => fs.map((f) => ({ category: f.category, code: f.code, file: f.file, line: f.line, test: f.test, symbol: f.symbol, cls: f.cls, message: f.message }));

export async function classifierSmoke(check: Check): Promise<void> {
  const dir = path.join(REPO_ROOT, 'scripts/healing/fixtures/classifier');
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  check('fixture corpus present', names.length >= 30, names.length);
  for (const n of names) {
    const base = n.replace(/\.json$/, '');
    const fx = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as Fixture;
    const text = fs.readFileSync(path.join(dir, `${base}.txt`), 'utf8');
    const got = runFixture(fx, text);
    const missing = fx.expected.filter((e) => !got.some((f) => matches(f, e)));
    check(`${base}: ${fx.expected.length} failure(s) with category/code/file/line`, got.length === fx.expected.length && !missing.length, { missing, got: brief(got) });
    check(
      `${base}: exact + generic signatures, id, clipped message/evidence on every failure`,
      got.every((f) => HEX16.test(f.signature) && HEX16.test(f.generic) && !!f.id && f.message.length <= 300 && f.evidence.length <= 2048 && f.signature === exactSignature(f) && f.generic === genericSignature(f)),
      brief(got),
    );
    // Same output under another checkout path (with a space): identical signatures.
    const moved = runFixture(fx, text.split(fx.root).join('/home/ci/my build/checkout'), '/home/ci/my build/checkout');
    check(`${base}: signatures stable across workspace path prefixes`, JSON.stringify(moved.map((f) => f.signature).sort()) === JSON.stringify(got.map((f) => f.signature).sort()), { got: brief(got), moved: brief(moved) });
  }

  // Signatures: line shift, numbers, literals, files.
  const ts = (file: string, line: number, a: string, b: string) => `${file}(${line},5): error TS2345: Argument of type '${a}' is not assignable to parameter of type '${b}'.`;
  const tsc = (out: string, root = '/work/proj') => classify({ kind: 'check', spec: { id: 'npm:typecheck', kind: 'typecheck', ecosystem: 'node' }, outcome: { exitCode: 2, output: out }, root });
  const [a] = tsc(ts('src/api/user.ts', 42, 'string', 'number'));
  const [b] = tsc(ts('src/api/user.ts', 57, 'string', 'number'));
  const [c] = tsc(ts('src/api/user.ts', 42, 'Date', 'number'));
  const [d] = tsc(ts('src/api/order.ts', 42, 'string', 'number'));
  check('line shift keeps the exact signature', a.signature === b.signature, [a, b]);
  check('quoted literals are normalised away', a.signature === c.signature);
  check('another file: different exact, same generic signature', a.signature !== d.signature && a.generic === d.generic);
  check('humanKey', humanKey(a) === 'TS2345@src/api/user.ts', humanKey(a));
  const n1 = normaliseMessage('Expected 3 but got 4 at /work/proj/src/a.ts:12:5 (id 3f2a9c1b7e, 2024-05-01T10:00:00Z)', '/work/proj');
  const n2 = normaliseMessage('Expected 30 but got 41 at /work/proj/src/a.ts:99:1 (id 0aa7d3e9f1, 2025-01-02T03:04:05Z)', '/work/proj');
  check('normaliseMessage: numbers, positions, hex ids, timestamps, root', n1 === n2 && !n1.includes('/work/proj') && n1.includes('src/a.ts'), [n1, n2]);
  check('normaliseMessage: uuids and other absolute paths', normaliseMessage('session 123e4567-e89b-12d3-a456-426614174000 in /usr/lib/node/x.js') === 'session * in x.js', normaliseMessage('session 123e4567-e89b-12d3-a456-426614174000 in /usr/lib/node/x.js'));
  const unit1 = exactSignature({ category: 'unit_test', message: 'expected 3 to be 4', file: 'src/sum.test.ts', test: 'sum › adds' });
  const unit2 = exactSignature({ category: 'unit_test', message: 'expected 7 to be 9', file: 'src/sum.test.ts', test: 'sum › adds' });
  const unit3 = exactSignature({ category: 'unit_test', message: 'expected 3 to be 4', file: 'src/sum.test.ts', test: 'sum › subtracts' });
  check('test signatures: numbers ignored, test id part of the key', unit1 === unit2 && unit1 !== unit3);

  // Cap, dedupe, evidence size.
  const many = Array.from({ length: 80 }, (_, i) => `src/f${i}.ts(1,1): error TS2304: Cannot find name 'x${i}'.`).join('\n');
  check('at most 50 failures per parse', tsc(many).length === 50);
  const collapsed = tsc(`${ts('src/a.ts', 1, 's', 'n')}\n${ts('src/a.ts', 9, 's', 'n')}`);
  check('duplicates collapse to one, later occurrences kept in the evidence', collapsed.length === 1 && collapsed[0].line === 1 && collapsed[0].evidence.includes('line 9:'), collapsed);
  const sameSig = tsc("src/a.ts(1,1): error TS2304: Cannot find name 'foo'.\nsrc/a.ts(5,1): error TS2304: Cannot find name 'bar'.");
  check('same-signature errors with different symbols: one failure naming both', sameSig.length === 1 && sameSig[0].evidence.includes("'bar'") && sameSig[0].evidence.includes("'foo'"), sameSig);
  const twoPkgs = tsc("src/a.ts(1,22): error TS2307: Cannot find module 'lodash' or its corresponding type declarations.\nsrc/a.ts(2,19): error TS2307: Cannot find module 'react' or its corresponding type declarations.");
  check('two missing packages in one file -> two dependency failures', twoPkgs.length === 2 && twoPkgs.every((f) => f.category === 'dependency') && twoPkgs.map((f) => f.symbol).sort().join() === 'lodash,react' && twoPkgs[0].signature !== twoPkgs[1].signature, brief(twoPkgs));
  const migTs = tsc("src/migrations/001_init.ts(3,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.");
  check('tsc error in a migration file: no database failure', migTs.length === 1 && migTs[0].category === 'typescript', brief(migTs));
  const huge = tsc(`${ts('src/a.ts', 1, 's', 'n')}\n${'  elaboration line that goes on and on and on\n'.repeat(200)}`);
  check('evidence clipped to 2 KB', huge.length === 1 && huge[0].evidence.length <= 2048);

  // Model errors.
  const model = (input: Omit<Extract<ClassifyInput, { kind: 'model' }>, 'kind' | 'modelName'>) => classify({ kind: 'model', modelName: 'qwen3:8b', ...input });
  const over = model({ failure: 'overload' });
  check("'overload' -> model_overload (environmental)", over.length === 1 && over[0].category === 'model_overload' && over[0].cls === 'environmental' && over[0].severity === 'medium', over);
  const oom = model({ error: new HttpError(500, '{"error":"model requires more system memory (12.1 GiB) than is available (7.9 GiB)"}', 'http://localhost:11434/api/chat') });
  check('HTTP 500 with an OOM body -> model_overload', oom[0]?.category === 'model_overload' && oom[0].code === 'model:overload', oom);
  const stall = model({ error: new ModelStallError('first-token', 60) });
  check('stall -> model_timeout (transient)', stall[0]?.category === 'model_timeout' && stall[0].cls === 'transient');
  const net = model({ error: Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:11434' } }) });
  check('connection refused -> model_unavailable (transient)', net[0]?.category === 'model_unavailable' && net[0].cls === 'transient', net);
  check('server/ratelimit/unroutable -> model_unavailable', ['server', 'ratelimit', 'unroutable'].every((k) => model({ failure: k })[0]?.category === 'model_unavailable'));
  check('toolcall -> model_output (deterministic)', model({ failure: 'toolcall' })[0]?.cls === 'deterministic' && model({ failure: 'toolcall' })[0]?.category === 'model_output');
  check('auth/quota -> permission (policy)', ['auth', 'quota'].every((k) => { const f = model({ failure: k })[0]; return f?.category === 'permission' && f.cls === 'policy'; }));
  check('overflow is left to compaction', model({ failure: 'overflow' }).length === 0);
  check('model failures carry the model name and model source', over[0].symbol === 'qwen3:8b' && over[0].source.kind === 'model');

  // Tool results.
  const run = (out: string, exitCode: number | null, command = 'npm test') =>
    classify({ kind: 'tool', name: 'run_command', args: { command }, result: { content: `$ ${command}\n${out}\n[exit code ${exitCode}]`, isError: exitCode !== 0, data: { exitCode } }, callId: 'c1', root: '/work/proj' });
  const gitRun = (command: string, out: string) => run(out, 0, command);
  check('git diff containing conflict text -> nothing', gitRun('git diff', 'diff --git a/x.md b/x.md\n+Automatic merge failed; fix conflicts and then commit the result.\n+CONFLICT (content): Merge conflict in src/a.ts\n+hint: Resolve all conflicts manually').length === 0);
  check('git log with an indented "both modified" line -> nothing', gitRun('git log -3', 'commit abc1234\nAuthor: a <a@b>\n\n    Fix merge\n\n    both modified:   src/a.ts\n    Automatic merge failed earlier').length === 0);
  check('git -C dir show with conflict text -> nothing', gitRun('git -C sub show HEAD', 'Automatic merge failed; fix conflicts and then commit the result.').length === 0);
  const rebase = run('error: could not apply 1a2b3c4... feat: x\nhint: Resolve all conflicts manually, mark them as resolved with', 1, 'cd app && git rebase main');
  check('git rebase "could not apply" -> git_conflict', rebase.length === 1 && rebase[0].category === 'git_conflict', brief(rebase));
  const statusLog = classify({ kind: 'tool', name: 'git_status', args: {}, result: { content: 'On branch main\nChanges not staged for commit:\n\tboth modified:   src/x.ts\n' } });
  check('"both modified" outside an Unmerged paths section -> nothing', statusLog.length === 0, statusLog);
  check('git_commit output with conflict text -> nothing', classify({ kind: 'tool', name: 'git_commit', args: {}, result: { content: 'Automatic merge failed; fix conflicts and then commit the result.' } }).length === 0);
  const migJest = run(' FAIL  src/db/migration.test.ts\n  ● migration runner › reports error\n\n    expect(received).toBe(expected)\n\n      at Object.<anonymous> (src/db/migration.test.ts:7:23)\n\nTests: 1 failed', 1);
  check('jest run of a migration test: no database failure', migJest.length > 0 && migJest.every((f) => f.category !== 'database'), brief(migJest));
  check('run_command exit 0 -> nothing', run('Error: something went wrong\n    at x (/work/proj/a.js:1:1)', 0).length === 0);
  const opaque = run('Something odd happened\nbailing out', 3, './build.sh');
  check("run_command non-zero, no parser match -> 'tool'", opaque.length === 1 && opaque[0].category === 'tool' && opaque[0].code === 'exit:3' && opaque[0].source.tool === 'run_command' && opaque[0].source.callId === 'c1', opaque);
  const denied = classify({ kind: 'tool', name: 'run_command', args: { command: 'npm i' }, result: { content: 'User declined to run the command.', isError: true }, decision: { deniedByUser: true } });
  check('denied approval -> permission (policy)', denied[0]?.category === 'permission' && denied[0].cls === 'policy' && denied[0].code === 'denied');
  for (const text of ['The user declined edit_file (src/a.ts).', 'The user denied this action: edit src/a.ts']) {
    for (const tool of ['edit_file', 'mcp_db__query']) {
      const d = classify({ kind: 'tool', name: tool, args: { path: 'src/a.ts' }, result: { content: text, isError: true } });
      check(`denial text without a decision on ${tool} -> permission ("${text.slice(0, 20)}…")`, d.length === 1 && d[0].category === 'permission' && d[0].cls === 'policy' && d[0].code === 'denied', brief(d));
    }
  }
  const blocked = classify({ kind: 'tool', name: 'write_file', args: { path: 'a.ts' }, decision: { blockedBy: 'rule' } });
  check('blocked by a rule -> permission', blocked[0]?.category === 'permission' && blocked[0].code === 'blocked:rule');
  const mcp = (content: string) => classify({ kind: 'tool', name: 'mcp_db__query', args: { sql: 'select 1' }, result: { content, isError: true } });
  const nc = mcp('Error: MCP server "db" is not connected: spawn ENOENT');
  check("MCP 'Not connected' -> notExecuted: true (transient)", nc[0]?.category === 'mcp' && nc[0].notExecuted === true && nc[0].cls === 'transient' && nc[0].symbol === 'db', nc);
  const closedBefore = mcp('Error: transport closed before the request was sent');
  check('MCP transport closed before send -> notExecuted: true', closedBefore[0]?.notExecuted === true);
  const to = mcp('MCP request to "db" timed out after 60s. Raise "timeout" for this server in .vscode/mcp.json.');
  check("MCP 'timed out' -> notExecuted: false (never replayed)", to[0]?.category === 'mcp' && to[0].notExecuted === false && to[0].code === 'MCP:timeout', to);
  const inv = mcp('MCP error -32602: Invalid params: "sql" is required');
  check('MCP -32602 -> deterministic', inv[0]?.code === 'MCP:-32602' && inv[0].cls === 'deterministic' && inv[0].notExecuted === false, inv);
  check('MCP success -> nothing', classify({ kind: 'tool', name: 'mcp_db__query', args: {}, result: { content: 'ok' } }).length === 0);
  const scan = classify({
    kind: 'tool',
    name: 'security_scan',
    args: {},
    result: {
      content: [
        '3 findings (1 critical, 1 high, 1 medium, 0 low) — 12 dependencies checked against OSV.dev, 40 files scanned.',
        '',
        '[critical] AWS access key — src/config.ts:4 (secret-aws-access-key). Fix: Move it to an environment variable.',
        '[high] lodash 4.17.15 (npm) — Prototype Pollution in lodash (GHSA-p6mc-m468-83gw, CVE-2020-8203) in package-lock.json. Fix: Upgrade to 4.17.19.',
        '[medium] Weak hash — src/hash.ts:2 (weak-hash-md5). Fix: Use SHA-256.',
      ].join('\n'),
      data: { findings: 3 },
    },
    root: '/work/proj',
  });
  check('security_scan: [critical]/[high] rows -> security with their severity', scan.length === 2 && scan[0].severity === 'critical' && scan[0].file === 'src/config.ts' && scan[0].line === 4 && scan[0].code === 'secret-aws-access-key' && scan[1].severity === 'high' && scan[1].code === 'GHSA-p6mc-m468-83gw' && scan[1].symbol === 'lodash' && scan.every((f) => f.category === 'security' && f.cls === 'policy'), brief(scan));
  check('security_scan without findings -> nothing', classify({ kind: 'tool', name: 'security_scan', args: {}, result: { content: 'No findings', data: { findings: 0 } } }).length === 0);
  const editDiag = classify({ kind: 'tool', name: 'edit_file', args: { path: 'src/a.ts', old_text: 'x', new_text: 'y' }, result: { content: 'Edited src/a.ts\n\nNew problems:\n3: Cannot find name \'y\'.\n9: Expected 1 arguments, but got 2.' }, root: '/work/proj' });
  check('edit result "New problems" -> typescript diagnostics at the edited file', editDiag.length === 2 && editDiag.every((f) => f.category === 'typescript' && f.file === 'src/a.ts') && editDiag[0].line === 3, brief(editDiag));
  const markers = classify({ kind: 'tool', name: 'write_file', args: { path: 'src/b.ts', content: 'a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feature\n' }, result: { content: 'Wrote src/b.ts' } });
  check('conflict markers in written content -> git_conflict (policy, high)', markers[0]?.category === 'git_conflict' && markers[0].cls === 'policy' && markers[0].severity === 'high' && markers[0].line === 2, markers);
  const editErr = classify({ kind: 'tool', name: 'edit_file', args: { path: 'src/a.ts' }, result: { content: 'old_text was not found in src/a.ts', isError: true } });
  check('failed edit -> tool (deterministic, low)', editErr[0]?.category === 'tool' && editErr[0].cls === 'deterministic' && editErr[0].severity === 'low');
  const gitTool = classify({ kind: 'tool', name: 'git_status', args: {}, result: { content: 'On branch main\nUnmerged paths:\n  (use "git add <file>..." to mark resolution)\n\tboth modified:   src/a.ts\n' } });
  check('git_status "both modified" -> git_conflict', gitTool.length === 1 && gitTool[0].category === 'git_conflict' && gitTool[0].file === 'src/a.ts', gitTool);

  // Checks.
  const chk = (output: string, extra: Partial<Extract<ClassifyInput, { kind: 'check' }>> = {}, eco: CheckEcosystem = 'node', kind: CheckKind = 'test') =>
    classify({ kind: 'check', spec: { id: `x:${kind}`, kind, ecosystem: eco, timeoutSeconds: 120 }, outcome: { exitCode: 1, output }, root: '/work/proj', ...extra });
  check('check exit 0 -> nothing', classify({ kind: 'check', spec: { id: 'npm:test', kind: 'test', ecosystem: 'node' }, outcome: { exitCode: 0, output: 'FAIL src/x.test.ts' } }).length === 0);
  const timeout = classify({ kind: 'check', spec: { id: 'npm:test', kind: 'test', ecosystem: 'node', timeoutSeconds: 300 }, outcome: { exitCode: null, output: 'running…', timedOut: true } });
  check('check timeout -> check_timeout', timeout.length === 1 && timeout[0].category === 'check_timeout' && timeout[0].source.checkId === 'npm:test', timeout);
  check('skipped check -> nothing', classify({ kind: 'check', spec: { id: 'npm:test', kind: 'test', ecosystem: 'node' }, outcome: { exitCode: null, output: '', skipped: { deniedByUser: true } } }).length === 0);
  const unparsed = chk('make: *** [all] Error 2', {}, 'make', 'build');
  check('unparsed failing build -> build category', unparsed.length === 1 && unparsed[0].category === 'build' && unparsed[0].message.includes('Error 2'), unparsed);
  const nodeMissing = "Error: Cannot find module 'left-pad'\nRequire stack:\n- /work/proj/src/index.js\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1077:15)";
  const pyMissing = "Traceback (most recent call last):\n  File \"/work/proj/app.py\", line 1, in <module>\n    import yaml\nModuleNotFoundError: No module named 'yaml'";
  check('missing modules are dependencies by default', chk(nodeMissing)[0]?.category === 'dependency' && chk(pyMissing, {}, 'python')[0]?.category === 'dependency');
  const wtNode = chk(nodeMissing, { worktreeMissingDeps: true });
  const wtPy = chk(pyMissing, { worktreeMissingDeps: true }, 'python');
  check('worktreeMissingDeps: Cannot find module / ModuleNotFoundError -> no failure (unverified)', wtNode.length === 0 && wtPy.length === 0, brief([...wtNode, ...wtPy]));
  const wtMixed = chk(`${nodeMissing}\n${ts('src/a.ts', 1, 's', 'n')}`, { worktreeMissingDeps: true }, 'node', 'typecheck');
  const pol = effectivePolicies({ enabled: true, maxRepairAttempts: 3, policies: {} });
  const st = { version: 1, rev: 0, sessionId: 's', turnKey: 0, phase: 'classifying', startedAt: 0, updatedAt: 0, owner: { pid: 1, host: 'h', kind: 'cli' }, baseline: undefined, checks: {}, changedFiles: [], agentWrites: {}, approvals: [], acceptedRisks: [], attempts: [], perCategory: {}, seen: {}, active: [], extraStepsUsed: 0 } as unknown as RecoveryState;
  const fixes = [...wtNode, ...wtPy, ...wtMixed].filter((f) => /Cannot find module|No module named/.test(f.message) && decide(st, f, pol[f.category], { now: 0, recoveryActive: true, totalCap: 8, delegateAllowed: false, independentGroups: 1 }).action === 'fix');
  check('worktreeMissingDeps: other errors kept, missing modules never sent to fix', wtMixed.length === 1 && wtMixed[0].category === 'typescript' && !fixes.length, brief(wtMixed));
  const npm404 = chk('npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/nope-pkg - Not found', { worktreeMissingDeps: true });
  check('worktreeMissingDeps leaves real registry misses as dependency', npm404[0]?.category === 'dependency', npm404);

  const mismatched = (Object.keys(DEFAULT_POLICIES) as FailureCategory[]).filter((c) => defaultClass(c) !== DEFAULT_POLICIES[c].cls);
  check('default class of every category matches DEFAULT_POLICIES', !mismatched.length, mismatched);
  check('check timeout is environmental', timeout[0]?.cls === 'environmental');

  // Diagnostics and loop stops.
  const diag = classify({ kind: 'diagnostics', text: "New errors after this edit:\n12: Type 'string' is not assignable to type 'number'.\n14: Cannot find name 'foo'.", file: '/work/proj/src/a.ts', root: '/work/proj' });
  check('"New errors after this edit" -> diagnostics failures', diag.length === 2 && diag[0].file === 'src/a.ts' && diag[0].line === 12 && diag[0].source.kind === 'diagnostics' && diag[0].category === 'typescript', diag);
  const getDiag = classify({ kind: 'diagnostics', text: "src/x.py:4:1 [Error] \"foo\" is not defined (Pylance)\nsrc/y.ts:2:3 [Warning] unused (ts)\nsrc/z.ts:7:9 [Error] Missing semicolon. (eslint)", root: '/work/proj' });
  check('get_diagnostics rows: errors only, category by source', getDiag.length === 2 && getDiag[0].category === 'compile' && getDiag[1].category === 'lint', brief(getDiag));
  const loop = classify({ kind: 'loop', reason: 'identical_calls' });
  check('loop -> loop (fatal)', loop.length === 1 && loop[0].category === 'loop' && loop[0].cls === 'fatal' && loop[0].code === 'loop:identical_calls' && loop[0].source.kind === 'loop');

  // Grouping.
  const compileErr = tsc("src/sum.ts(3,7): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\nsrc/sum.ts(9,7): error TS2345: Argument of type '() => number' is not assignable to parameter of type 'number'. Did you mean to call this expression?\nsrc/other.ts(1,1): error TS2304: Cannot find name 'q'.");
  const tests = chk(" FAIL  src/sum.test.ts\n  ● sum › adds\n\n    TypeError: x.trim is not a function\n\n      at sum (src/sum.ts:4:12)\n      at Object.<anonymous> (src/sum.test.ts:7:23)\n\n  ● misc › works\n\n    expect(received).toBe(expected)\n\n      at Object.<anonymous> (src/misc.test.ts:3:1)\n\nTests: 2 failed");
  const groups = groupFailures([...tests, ...compileErr], '/work/proj');
  const sumGroup = groups.find((g) => g.lead.file === 'src/sum.ts');
  check('groupFailures: same file+code together, tests under the compile error of their top frame', groups.length === 3 && !!sumGroup && sumGroup.failures.length === 3 && sumGroup.lead.category === 'typescript' && groups[0].lead.category === 'typescript', groups.map((g) => ({ lead: humanKey(g.lead), n: g.failures.length })));
}
