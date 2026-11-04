import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { hasMermaid, parseLinkTarget, preprocessFootnotes, renderMarkdown, rewriteResourceUrls, splitFrontMatter } from '../ui/markdown/render';

suite('Markdown reader: pure rendering', () => {
  test('footnotes are numbered by first use and keep every line where it was', () => {
    const src = ['Intro[^b] and[^a], again[^b].', '', '```', 'code [^a]', '```', 'Unknown [^zz] stays.', '', '[^a]: Alpha *note*', '[^b]: Beta with `code`'].join('\n');
    const out = preprocessFootnotes(src);
    const lines = out.split('\n');
    assert.strictEqual(lines.length, src.split('\n').length + 2, 'the list is appended after the last line');
    assert.ok(/href="#fn-b" id="fnref-b">1</.test(lines[0]), lines[0]);
    assert.ok(/href="#fn-a" id="fnref-a">2</.test(lines[0]), lines[0]);
    assert.ok(/id="fnref-b-2">1</.test(lines[0]), 'a second reference gets its own back-link id');
    assert.strictEqual(lines[3], 'code [^a]', 'footnotes inside fenced code are untouched');
    assert.strictEqual(lines[5], 'Unknown [^zz] stays.');
    assert.strictEqual(lines[7], '', 'a definition becomes a blank line');
    assert.strictEqual(lines[8], '');
    assert.strictEqual(lines[9], '');
    assert.ok(/^<section class="footnotes">.*<li id="fn-b">Beta with <code>code<\/code>.*<li id="fn-a">Alpha <em>note<\/em>/.test(lines[10]), lines[10]);
    assert.strictEqual(preprocessFootnotes('no notes here'), 'no notes here');
  });

  test('a footnote definition followed directly by a heading leaves the heading as Markdown', () => {
    const src = ['Text[^1].', '[^1]: note', '## Next', 'More *text*'].join('\n');
    const lines = preprocessFootnotes(src).split('\n');
    assert.deepStrictEqual(lines.slice(0, 4).map((l) => l.replace(/<sup.*<\/sup>/, '')), ['Text.', '', '## Next', 'More *text*']);
    assert.strictEqual(lines[4], '', 'a blank line closes the preceding block before the HTML');
    assert.ok(lines[5].startsWith('<section class="footnotes">'), lines[5]);
    assert.strictEqual(lines.length, 6);
  });

  test('parseLinkTarget: anchors, external links and workspace paths; other schemes are ignored', () => {
    const cases: [string, ReturnType<typeof parseLinkTarget>][] = [
      ['#a', { kind: 'anchor', anchor: 'a' }],
      ['https://x', { kind: 'external', href: 'https://x' }],
      ['mailto:a', { kind: 'external', href: 'mailto:a' }],
      ['src/a.ts:10', { kind: 'path', path: 'src/a.ts', line: 10 }],
      ['src/a.ts#L10', { kind: 'path', path: 'src/a.ts', line: 10 }],
      ['src/a.ts#L10-L20', { kind: 'path', path: 'src/a.ts', line: 10, endLine: 20 }],
      ['docs/b.md#intro', { kind: 'path', path: 'docs/b.md', anchor: 'intro' }],
      ['My%20File.md', { kind: 'path', path: 'My File.md' }],
      ['../x.pdf#page=3', { kind: 'path', path: '../x.pdf', page: 3 }],
      ['javascript:alert(1)', undefined],
      ['file:///etc/passwd', undefined],
      ['', undefined],
    ];
    for (const [href, want] of cases) {
      assert.deepStrictEqual(parseLinkTarget(href), want, href);
    }
  });

  test('media/mdview.js carries the same link rules as the host', () => {
    // The webview cannot import the host module, so it holds a copy; both must answer the same.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'mdview.js'), 'utf8');
    const m = /\/\/ <parseLinkTarget>\n([\s\S]*?)\n\s*\/\/ <\/parseLinkTarget>/.exec(src);
    assert.ok(m, 'mdview.js marks its parseLinkTarget copy');
    const webviewParse = new Function(`${m[1]}; return parseLinkTarget;`)() as typeof parseLinkTarget;
    for (const href of ['#a', '#caf%C3%A9', 'https://x', 'mailto:a', 'src/a.ts:10', 'src/a.ts:10:4', 'src/a.ts#L10', 'src/a.ts#L10-L20', 'src/a.ts#L20-L10', 'docs/b.md#intro', 'My%20File.md', '../x.pdf#page=3', 'a.md?x=1', 'C:/x/y.md', 'javascript:alert(1)', 'vbscript:x', 'data:text/html,x', '#', '']) {
      assert.deepStrictEqual(webviewParse(href), parseLinkTarget(href), href);
    }
  });

  test('rewriteResourceUrls: relative, /root-relative and srcset paths; remote and data URLs untouched', () => {
    const to = (abs: string) => `RES(${abs.split(path.sep).join('/')})`;
    const base = path.join('/ws', 'docs');
    const html = '<p><img alt="a" src="img/a.png"> <img src="/assets/b.png"> <img src="https://x/c.png"> <img src="data:image/png;base64,AA"> <img src="../up.png"></p><picture><source srcset="s1.png 1x, s2.png 2x"><img src="x%20y.png" srcset="w.png 400w"></picture>';
    const out = rewriteResourceUrls(html, base, '/ws', to);
    assert.ok(out.includes('src="RES(/ws/docs/img/a.png)"'), out);
    assert.ok(out.includes('src="RES(/ws/assets/b.png)"'), out);
    assert.ok(out.includes('src="https://x/c.png"') && out.includes('src="data:image/png;base64,AA"'), out);
    assert.ok(out.includes('src="RES(/ws/up.png)"'), '.. stays an absolute file path');
    assert.ok(out.includes('srcset="RES(/ws/docs/s1.png) 1x, RES(/ws/docs/s2.png) 2x"'), out);
    assert.ok(out.includes('src="RES(/ws/docs/x y.png)" srcset="RES(/ws/docs/w.png) 400w"'), out);
  });

  test('front matter is split off with its line count; mermaid fences are detected', async () => {
    const fm = splitFrontMatter('---\ntitle: X\ntags: [a, b]\n---\n# H\n');
    assert.deepStrictEqual(fm.meta, { title: 'X', tags: ['a', 'b'] });
    assert.strictEqual(fm.lines, 4);
    assert.strictEqual(fm.body, '# H\n');
    assert.strictEqual(splitFrontMatter('# No front matter').lines, 0);
    const engine = async (md: string) => `<pre><code class="language-mermaid">${md.length}</code></pre>`;
    const r = await renderMarkdown({ markdown: '---\ntitle: X\n---\n# H', engine }, (a) => a);
    assert.deepStrictEqual(r.frontMatter, { title: 'X' });
    assert.strictEqual(r.frontMatterLines, 3);
    assert.ok(r.hasMermaid);
    assert.ok(hasMermaid('<pre><code class="hljs language-mermaid">'));
    assert.ok(!hasMermaid('<pre><code class="language-ts">'));
    const failing = await renderMarkdown({ markdown: 'a <b>', engine: async () => Promise.reject(new Error('no engine')) }, (a) => a);
    assert.strictEqual(failing.html, '<pre>a &lt;b&gt;</pre>');
  });
});
