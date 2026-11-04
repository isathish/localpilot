import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { WorkspaceContext } from '../context/workspaceContext';
import { commitBlock, formatFolderContent, isCommitRef, isUrlRef, parseCommitLog } from '../context/mentionRefs';
import { searchCommits } from '../context/mentionResolvers';
import { imageSize, imageTooLarge, MAX_IMAGE_SIDE } from '../ui/imageSize';

const log = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, append() {}, appendLine() {} } as unknown as vscode.LogOutputChannel;

function pngHeader(w: number, h: number): Uint8Array {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function jpegHeader(w: number, h: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0x00, 0x11, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}

suite('Mentions: folders, commits, URLs and attachment limits', () => {
  test('commit and URL refs', () => {
    assert.ok(isCommitRef('abc1234') && isCommitRef('@0123456789abcdef0123456789abcdef01234567'));
    assert.ok(!isCommitRef('abc12') && !isCommitRef('src/abc1234') && !isCommitRef('ghijklm'));
    assert.ok(isUrlRef('https://example.com/a?b=1') && isUrlRef('@http://x.y'));
    assert.ok(!isUrlRef('ftp://x') && !isUrlRef('example.com'));
    assert.deepStrictEqual(parseCommitLog('abc1234 Fix the thing\n\nnot a line\ndef5678 Add: more\n'), [
      { sha: 'abc1234', subject: 'Fix the thing' },
      { sha: 'def5678', subject: 'Add: more' },
    ]);
    const block = commitBlock('abc1234', 'x'.repeat(50), 20);
    assert.match(block, /^<git_commit hash="abc1234">\nx{20}\n… \[cut at 20 of 50 characters/);
  });

  test('folder content: tree, child files, caps', () => {
    const out = formatFolderContent('src/ui', [
      { name: 'b.ts', text: 'B'.repeat(30) },
      { name: 'sub', dir: true },
      { name: 'a.ts', text: 'A' },
      { name: 'logo.png', note: 'image, 2.0 KB' },
    ], { fileChars: 20, folderChars: 1000 });
    const [tree] = out.split('\n\n');
    assert.strictEqual(tree, '<folder_content path="src/ui">\n├── sub/\n├── a.ts\n├── b.ts\n└── logo.png (image, 2.0 KB)');
    assert.ok(out.includes('<file_content path="src/ui/a.ts">\nA\n</file_content>'), out);
    assert.match(out, /<file_content path="src\/ui\/b\.ts">\nB{20}\n… \[cut at 20 of 30 characters/);
    assert.ok(!out.includes('path="src/ui/sub"') && !out.includes('path="src/ui/logo.png"'), out);
    assert.ok(out.endsWith('</folder_content>'));

    const big = formatFolderContent('d', [
      { name: 'one.txt', text: 'x'.repeat(5000) },
      { name: 'two.txt', text: 'y'.repeat(5000) },
      { name: 'three.txt', skipped: true },
    ], { fileChars: 20_000, folderChars: 6000 });
    assert.ok(big.includes('x'.repeat(5000)), 'the first file fits');
    assert.match(big, /y{1000}\n… \[cut at 1,000 of 5,000 characters; the folder limit was reached/);
    assert.match(big, /Not included, over the 6,000-character folder limit: three\.txt/);
    assert.match(formatFolderContent('empty', []), /\(empty folder\)/);
  });

  test('image dimensions from the header', () => {
    assert.deepStrictEqual(imageSize(pngHeader(640, 480)), { width: 640, height: 480, format: 'png' });
    assert.deepStrictEqual(imageSize(jpegHeader(8000, 600)), { width: 8000, height: 600, format: 'jpeg' });
    const gif = Buffer.from('GIF89a\x20\x03\x58\x02\x00\x00', 'latin1');
    assert.deepStrictEqual(imageSize(gif), { width: 800, height: 600, format: 'gif' });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBPVP8X', 8, 'ascii');
    webp.writeUIntLE(1919, 24, 3);
    webp.writeUIntLE(1079, 27, 3);
    assert.deepStrictEqual(imageSize(webp), { width: 1920, height: 1080, format: 'webp' });
    assert.strictEqual(imageSize(Buffer.from('not an image at all')), undefined);
    assert.strictEqual(imageTooLarge('ok.png', pngHeader(MAX_IMAGE_SIDE, 100)), undefined);
    assert.match(imageTooLarge('wide.jpg', jpegHeader(8000, 600)) ?? '', /wide\.jpg is 8000×600 px; images may be at most 7680 px/);
  });

  test('readAttachment: a folder, a commit, a large file and a refused URL', async function () {
    this.timeout(30_000);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mentions-'));
    const git = (...args: string[]) => cp.execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    const w = new WorkspaceContext(log);
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const before = cfg.inspect<string>('approvals.network')?.globalValue;
    try {
      await fs.mkdir(path.join(dir, 'pkg', 'nested'), { recursive: true });
      await fs.writeFile(path.join(dir, 'pkg', 'index.ts'), 'export const answer = 42;\n');
      await fs.writeFile(path.join(dir, 'pkg', 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 0]));
      await fs.writeFile(path.join(dir, 'pkg', 'nested', 'deep.ts'), 'export const deep = true;\n');
      const folder = await w.readAttachment('pkg', dir);
      assert.match(folder, /^<folder_content path="pkg">\n├── nested\/\n├── blob\.bin \(binary, 6 B\)\n└── index\.ts/);
      assert.ok(folder.includes('<file_content path="pkg/index.ts">\nexport const answer = 42;'), folder);
      assert.ok(!folder.includes('deep = true'), 'subfolders are listed, not read');

      git('init', '-q');
      git('add', '.');
      git('commit', '-q', '-m', 'Add the answer module');
      const sha = git('rev-parse', '--short=8', 'HEAD').trim();
      const commit = await w.readAttachment(sha, dir);
      assert.match(commit, new RegExp(`^<git_commit hash="${sha}`));
      assert.ok(commit.includes('Add the answer module') && commit.includes('+export const answer = 42;') && /pkg\/index\.ts\s+\|\s+1 \+/.test(commit), commit);
      assert.deepStrictEqual((await searchCommits('ANSWER', dir)).map((c) => c.subject), ['Add the answer module']);
      assert.strictEqual((await searchCommits(sha, dir))[0]?.subject, 'Add the answer module');
      assert.match(await w.readAttachment('deadbee', dir), /error="not found"/, 'an unknown hash falls back to a (missing) file');

      const huge = path.join(dir, 'huge.log');
      await fs.writeFile(huge, '');
      await fs.truncate(huge, 21 * 1024 * 1024);
      assert.match(await w.readAttachment('huge.log', dir), /^<attachment path="huge\.log" error="too large">\n\(huge\.log is 21\.0 MB, over the 20\.0 MB attachment limit/);

      await cfg.update('approvals.network', 'never', vscode.ConfigurationTarget.Global);
      assert.match(await w.readAttachment('@https://example.com/'), /^<url_content url="https:\/\/example\.com\/" error="declined">/);
    } finally {
      await cfg.update('approvals.network', before, vscode.ConfigurationTarget.Global);
      w.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
