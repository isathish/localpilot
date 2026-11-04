/**
 * Smoke checks for mentions and attachment limits (bundled into scripts/smoke.ts): `@folder` content with its caps,
 * commit and URL refs, and the image-dimension reader behind the 7,680 px limit.
 */
import { commitBlock, formatFolderContent, isCommitRef, isUrlRef, parseCommitLog } from '../src/context/mentionRefs';
import { imageSize, imageTooLarge } from '../src/ui/imageSize';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

export async function mentions(check: Check): Promise<void> {
  console.log('\n— mentions —');
  const folder = formatFolderContent('src', [{ name: 'b.ts', text: 'bbb' }, { name: 'lib', dir: true }, { name: 'a.ts', text: 'a'.repeat(50) }, { name: 'x.zip', note: 'binary, 1 KB' }], { fileChars: 10, folderChars: 100 });
  check('@folder: one-level tree, folders first', folder.startsWith('<folder_content path="src">\n├── lib/\n├── a.ts\n├── b.ts\n└── x.zip (binary, 1 KB)'), folder);
  check('@folder: child files inlined and cut per file', folder.includes('<file_content path="src/b.ts">\nbbb\n</file_content>') && /a{10}\n… \[cut at 10 of 50 characters/.test(folder), folder);
  const capped = formatFolderContent('d', [{ name: '1', text: 'x'.repeat(4000) }, { name: '2', text: 'y'.repeat(4000) }, { name: '3', text: 'z'.repeat(4000) }], { folderChars: 5000 });
  check('@folder: the folder cap cuts and lists what is left', /y{1000}\n… \[cut at 1,000/.test(capped) && /folder limit: 3\./.test(capped), capped);
  check('@<hash> and @https:// refs', isCommitRef('@1a2b3c4') && !isCommitRef('1a2b3c') && isUrlRef('https://a.b/c') && !isUrlRef('a.b/c'));
  check('git log --format="%h %s" parsed for the @ menu', JSON.stringify(parseCommitLog('1a2b3c4 First\nbad\n')) === JSON.stringify([{ sha: '1a2b3c4', subject: 'First' }]));
  check('commit block capped', /^<git_commit hash="1a2b3c4">\nx{5}\n… \[cut at 5 of 9/.test(commitBlock('1a2b3c4', 'x'.repeat(9), 5)));
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(9000, 16);
  png.writeUInt32BE(10, 20);
  const size = imageSize(png);
  check('PNG size from the IHDR header', size?.width === 9000 && size.height === 10 && size.format === 'png', size);
  check('images over 7,680 px on a side are refused', /9000×10 px/.test(imageTooLarge('w.png', png) ?? '') && imageTooLarge('t.txt', Buffer.from('plain text')) === undefined);
}
