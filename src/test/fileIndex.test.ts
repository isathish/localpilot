import * as assert from 'assert';
import * as vscode from 'vscode';
import { FileIndex } from '../context/fileIndex';
import { foldersOf, fuzzyMatch, MentionEntry, rankMentions } from '../context/mentionSearch';

suite('@ mention search (pure)', () => {
  const entries = (paths: string[]): MentionEntry[] => paths.map((p) => ({ ref: p, display: p, kind: 'file' }));

  test('fuzzy match is a case-insensitive subsequence that prefers word starts', () => {
    assert.deepStrictEqual(fuzzyMatch('cc', 'chatController.ts')?.positions, [0, 4]);
    assert.ok(fuzzyMatch('CHATCTL', 'src/ui/chatController.ts'));
    assert.strictEqual(fuzzyMatch('zz', 'chatController.ts'), undefined);
  });

  test('@chatctl finds chatController.ts among 3,000 files within 100 ms', () => {
    const files = entries(['src/ui/chatController.ts', 'src/ui/chatViewProvider.ts', 'src/agent/chat.ts']);
    for (let i = 0; i < 3000; i++) {
      files.push(...entries([`lib${i % 30}/part${i}/module${i}.ts`]));
    }
    const all = [...files, ...foldersOf(files)];
    const t0 = Date.now();
    const hits = rankMentions('chatctl', all);
    assert.ok(Date.now() - t0 < 100);
    assert.strictEqual(hits[0]?.ref, 'src/ui/chatController.ts');
  });

  test('open editors rank first and recently attached files next', () => {
    const all = entries(['a/one.ts', 'b/two.ts', 'c/three.ts']);
    const hits = rankMentions('', all, { open: ['c/three.ts'], recent: ['b/two.ts'] });
    assert.deepStrictEqual(hits.map((h) => h.ref), ['c/three.ts', 'b/two.ts', 'a/one.ts']);
    assert.ok(hits[0].open && hits[1].recent);
  });

  test('folders come from file paths and keep the multi-root form', () => {
    const f = foldersOf([{ ref: 'api/src/ui/a.ts', display: 'api:/src/ui/a.ts', kind: 'file' }]);
    assert.deepStrictEqual(f.map((x) => [x.ref, x.display]), [['api/src', 'api:/src/'], ['api/src/ui', 'api:/src/ui/']]);
    const hit = rankMentions('ui', f)[0];
    assert.strictEqual(hit.label, 'ui/');
    assert.deepStrictEqual(hit.labelHl, [0, 1]);
  });
});

suite('FileIndex', () => {
  test('indexes workspace files but not node_modules', async function () {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      this.skip();
    }
    const dir = vscode.Uri.joinPath(root!, 'lp-fileindex');
    const enc = new TextEncoder();
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'src', 'mentionTarget.ts'), enc.encode('export {};\n'));
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'node_modules', 'pkg', 'mentionTarget.js'), enc.encode('module.exports = {};\n'));
    const index = new FileIndex();
    try {
      const hits = await index.search('mentionTarget');
      const refs = hits.map((h) => h.ref);
      assert.ok(refs.includes('lp-fileindex/src/mentionTarget.ts'), refs.join(', '));
      assert.ok(!refs.some((r) => r.includes('node_modules')), refs.join(', '));
      assert.ok(refs.includes('lp-fileindex/src') || (await index.search('lp-fileindex/src')).some((h) => h.kind === 'folder'));
    } finally {
      index.dispose();
      await vscode.workspace.fs.delete(dir, { recursive: true });
    }
  });
});
