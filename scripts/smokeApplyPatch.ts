/**
 * Smoke checks for apply_patch (bundled into scripts/smoke.ts): the `*** Begin Patch` parser, the hunk applier with
 * its fuzz levels and line endings, the multi-file plan, edit-tool routing by model and the write_file preview.
 */
import { applyHunks, parsePatch, patchArg, PatchHunk, patchPaths, planPatch, seekLines } from '../src/tools/applyPatch';
import { evaluatePermission } from '../src/agent/permissions';
import { emptySettings } from '../src/agent/settings';
import { editToolsToOmit, prefersApplyPatch } from '../src/agent/toolRelevance';
import { writePreview } from '../src/tools/lineDiff';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

const patch = (...body: string[]) => ['*** Begin Patch', ...body, '*** End Patch'].join('\n');
const hunk = (lines: string[], anchors: string[] = [], eof = false): PatchHunk => ({ anchors, eof, lines: lines.map((l) => ({ op: l[0] as ' ' | '-' | '+', text: l.slice(1) })) });
const throwsLike = (fn: () => unknown, re: RegExp): boolean => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(e instanceof Error ? e.message : String(e));
  }
};

export async function applyPatchChecks(check: Check): Promise<void> {
  console.log('\n[apply_patch]');
  const upd = parsePatch(patch('*** Update File: a.ts', '@@ function main', ' keep', '-old', '+new'));
  check('parse: update with anchor', upd.length === 1 && upd[0].type === 'update' && upd[0].hunks[0].anchors[0] === 'function main' && upd[0].hunks[0].lines.length === 3, upd);
  const add = parsePatch(patch('*** Add File: n.txt', '+a', '', '+b', '', ''))[0];
  check('parse: add file keeps inner blank lines, drops trailing ones', add.type === 'add' && add.content === 'a\n\nb\n', add);
  check('parse: delete', JSON.stringify(parsePatch(patch('*** Delete File: x'))) === '[{"type":"delete","path":"x"}]');
  const mv = parsePatch(patch('*** Update File: a', '*** Move to: b', '-x', '+y'))[0];
  check('parse: move to', mv.type === 'update' && mv.moveTo === 'b');
  const multi = parsePatch(patch('*** Update File: a', '@@ class A', '@@ m()', '-x', '+y', '@@ n()', '-p', '+q'))[0];
  check('parse: stacked anchors and a second hunk', multi.type === 'update' && JSON.stringify(multi.hunks.map((h) => h.anchors)) === '[["class A","m()"],["n()"]]', multi);
  const uni = parsePatch(patch('*** Update File: a', '@@ -1,3 +1,4 @@', '-x', '+y'))[0];
  check('parse: unified @@ header is no anchor', uni.type === 'update' && uni.hunks[0].anchors.length === 0);
  check('parse: %%bash heredoc wrapper', parsePatch(`%%bash\napply_patch <<"EOF"\n${patch('*** Delete File: w')}\nEOF\n`)[0]?.path === 'w');
  check('parse: code fence and CRLF', parsePatch('```\r\n' + patch('*** Delete File: f').replace(/\n/g, '\r\n') + '\r\n```')[0]?.path === 'f');
  check('parse: no Begin/End lines', parsePatch('*** Update File: a\n-x\n+y').length === 1);
  check('parse: stray line names its line', throwsLike(() => parsePatch(patch('*** Update File: a', 'oops')), /^Line 3: in a/));
  check('parse: duplicate file refused', throwsLike(() => parsePatch(patch('*** Delete File: a', '*** Delete File: a')), /more than once/));
  check('parse: update without changes refused', throwsLike(() => parsePatch(patch('*** Update File: a', ' ctx')), /no "-" or "\+" lines/));
  check('parse: end of file marker', (() => { const o = parsePatch(patch('*** Update File: a', ' z', '+e', '*** End of File'))[0]; return o.type === 'update' && o.hunks[0].eof; })());
  check('patchPaths: includes move targets', patchPaths(patch('*** Update File: a', '*** Move to: b', '-x', '+y')).join() === 'a,b');

  check('apply: exact', applyHunks('a\nb\nc\n', [hunk([' a', '-b', '+B', ' c'])]).content === 'a\nB\nc\n');
  const f1 = applyHunks('a  \nb\n', [hunk([' a', '-b', '+B'])]);
  check('apply: trailing whitespace is fuzz 1 and the context line is kept', f1.fuzz === 1 && f1.content === 'a  \nB\n', f1);
  const f2 = applyHunks('    a\n    b\n', [hunk([' a', '-b', '+    B'])]);
  check('apply: surrounding whitespace is fuzz 2', f2.fuzz === 2 && f2.content === '    a\n    B\n', f2);
  check('apply: NFC normalization', applyHunks('caf\u00e9\nx\n', [hunk([' cafe\u0301', '-x', '+y'])]).content === 'caf\u00e9\ny\n');
  check('apply: anchor selects the later occurrence', applyHunks('f() {\n  1\n}\ng() {\n  1\n}\n', [hunk(['-  1', '+  2'], ['g() {'])]).content === 'f() {\n  1\n}\ng() {\n  2\n}\n');
  check('apply: CRLF kept', applyHunks('a\r\nb\r\n', [hunk([' a', '-b', '+B'])]).content === 'a\r\nB\r\n');
  check('apply: no final newline kept', applyHunks('a\nb', [hunk(['-b', '+B'])]).content === 'a\nB');
  check('apply: pure addition appends', applyHunks('a\n', [hunk(['+b'])]).content === 'a\nb\n');
  check('apply: end of file hunk matches the last lines', applyHunks('x\ny\nx\n', [hunk(['-x', '+E'], [], true)]).content === 'x\ny\nE\n');
  check('apply: trailing empty context line falls back', applyHunks('a\nb\n', [hunk([' b', '+c', ' '])]).content === 'a\nb\nc\n');
  check('apply: missing context error', throwsLike(() => applyHunks('a\n', [hunk(['-zz', '+y'])], 'f'), /^f: these lines were not found/));
  check('apply: missing anchor error', throwsLike(() => applyHunks('a\n', [hunk(['-a', '+b'], ['nope'])], 'f'), /"@@ nope" line was not found/));
  check('seekLines: exact beats loose', JSON.stringify(seekLines(['x ', 'x'], ['x'], 0)) === '{"at":1,"fuzz":0}');

  const plan = planPatch(parsePatch(patch('*** Update File: a', '-1', '+2', '*** Add File: n', '+new', '*** Delete File: d', '*** Update File: m', '*** Move to: m2', '-x', '+y')), (p) => ({ a: '1\n', d: 'gone\n', m: 'x\n' } as Record<string, string>)[p]);
  check('plan: update, add, delete, move', plan.map((f) => f.kind).join() === 'update,add,delete,move' && plan[3].after === 'y\n', plan);
  check(
    'plan: all errors together',
    throwsLike(() => planPatch(parsePatch(patch('*** Update File: gone', '-a', '+b', '*** Delete File: none')), () => undefined), /gone does not exist[\s\S]*none does not exist/)
  );

  const tie = parsePatch(patch('*** Update File: f', '@@ head', '+inserted', '@@', ' b', '-c', '+C'))[0];
  const tieOut = tie.type === 'update' ? applyHunks('head\nb\nc\nd\n', tie.hunks).content : '';
  check('apply: an anchored insert lands before a later hunk on the same line', tieOut === 'head\ninserted\nb\nC\nd\n', tieOut);
  const secret = patch('*** Update File: secrets/key', '-a', '+b');
  const perm = { ...emptySettings().permissions, deny: ['Edit(secrets/**)'] };
  check('permissions: a path rule sees the patch in diff/content/patch', patchArg({ input: '', patch: 'x' }) === 'x' && [{ diff: secret }, { content: secret }, { input: '', patch: secret }].every((a) => evaluatePermission(perm, 'apply_patch', a).decision === 'deny'));
  check('permissions: a patch naming no file is denied by a path deny rule', evaluatePermission(perm, 'apply_patch', { input: 'garbage' }).decision === 'deny');

  check('routing: gpt-oss prefers apply_patch, qwen does not', prefersApplyPatch('gpt-oss:20b') && !prefersApplyPatch('qwen2.5-coder:7b'));
  const all = ['edit_file', 'write_file', 'apply_patch'];
  check('routing: auto + gpt drops edit_file and write_file', [...editToolsToOmit(all, 'gpt-4.1', 'auto')].sort().join() === 'edit_file,write_file');
  check('routing: auto + other model drops apply_patch', [...editToolsToOmit(all, 'llama3', 'auto')].join() === 'apply_patch');
  check('routing: no apply_patch available keeps edit_file', editToolsToOmit(['edit_file'], 'gpt-oss', 'apply_patch').size === 0);
  check('writePreview: new file shows its first lines', writePreview(undefined, '1\n2\n3\n', 2) === '+1\n+2\n… 1 more lines');
  check('writePreview: existing file shows a diff', writePreview('a\nb\n', 'a\nc\n') === '@@ -1,2 +1,2 @@\n a\n-b\n+c');
}
