import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const EXT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * The chat webview's syntax highlighter runs on VS Code's UI thread: a hang or a quadratic path there freezes the
 * whole window ("The window is not responding"). `media/chat.js` is a browser IIFE, so the highlighter is lifted
 * out of the source text and run in a sandbox — with a time budget, so a regression fails the test instead of
 * hanging the runner.
 */
function loadHighlighter(): (code: string, lang: string) => string {
  const src = fs.readFileSync(path.join(EXT_ROOT, 'media', 'chat.js'), 'utf8');
  const start = src.indexOf('  const KW = {');
  const end = src.indexOf('  /** Fenced block with header actions.');
  assert.ok(start > 0 && end > start, 'highlighter section not found in media/chat.js');
  const escLine = src.split('\n').find((l) => l.trim().startsWith('const esc = '));
  assert.ok(escLine, 'esc helper not found in media/chat.js');
  const sandbox: Record<string, unknown> = {};
  vm.runInNewContext(`${escLine}\n${src.slice(start, end)}\nhighlightRaw_ = highlightRaw;`, sandbox, { timeout: 10_000 });
  assert.strictEqual(typeof sandbox.highlightRaw_, 'function', 'highlightRaw not found in media/chat.js');
  // Each call gets its own budget; the sandbox throws on expiry rather than spinning forever.
  return (code, lang) => vm.runInNewContext('highlightRaw_(code, lang)', { ...sandbox, code, lang }, { timeout: 2_000 }) as string;
}

suite('Chat syntax highlighter', () => {
  const highlight = loadHighlighter();
  const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

  test('a bare @ (decorators, e-mails, $@) terminates and keeps the text', () => {
    for (const [lang, code] of [
      ['ts', '@Component({ selector: "x" })\nclass X {}'],
      ['py', '@dataclass\nclass A:\n    pass'],
      ['java', '@Override public void f() {}'],
      ['js', 'const re = /[\\w.@-]+/; mail("a@b.co")'],
      ['go', 'x := a@b'],
      ['sh', 'for a in "$@"; do echo "$a"; done'],
    ] as const) {
      const out = highlight(code, lang);
      assert.strictEqual(text(out), code, `${lang}: highlighted text must equal the input`);
    }
  });

  test('a decorator is one token; keywords, calls and members are still classified', () => {
    const out = highlight('@Component() class X { run() { this.items.map(f); return 42; } }', 'ts');
    assert.ok(out.includes('<span class="tk-f">@Component</span>'), out);
    assert.ok(out.includes('<span class="tk-k">class</span>'), out);
    assert.ok(out.includes('<span class="tk-p">items</span>'), out);
    assert.ok(out.includes('<span class="tk-f">map</span>'), out);
    assert.ok(out.includes('<span class="tk-n">42</span>'), out);
  });

  test('shell variables and flags are tokenised in place', () => {
    const out = highlight('ls -la --color=auto $HOME ${FOO} $1', 'sh');
    for (const t of ['<span class="tk-p">-la</span>', '<span class="tk-p">--color</span>', '<span class="tk-v">$HOME</span>', '<span class="tk-v">${FOO}</span>', '<span class="tk-v">$1</span>']) {
      assert.ok(out.includes(t), `${t} in ${out}`);
    }
  });

  test('a long block highlights in linear time (streaming re-renders it many times a second)', function () {
    this.timeout(15_000);
    const py = 'def f(x):\n    return x.y . z(1)\n"""doc"""\n# c\nclass Foo(Bar):\n    pass\n'.repeat(900); // ~59 KB, indented
    const sh = 'for f in *.ts; do\n  echo "$f ${HOME} $1" --color=auto -x\n  grep -rn --include=*.ts foo . | head -5\ndone\n'.repeat(600);
    const ts = fs.readFileSync(path.join(EXT_ROOT, 'media', 'chat.js'), 'utf8').slice(0, 59_000);
    for (const [lang, code] of [['py', py], ['sh', sh], ['ts', ts]] as const) {
      const small = code.slice(0, 10_000);
      const t0 = performance.now();
      highlight(small, lang);
      const tSmall = performance.now() - t0;
      const t1 = performance.now();
      highlight(code, lang);
      const tFull = performance.now() - t1;
      // Six times the input should cost roughly six times the work, not thirty-six; generous bound for slow CI.
      assert.ok(tFull < 500, `${lang}: ${code.length} chars took ${tFull.toFixed(0)} ms`);
      assert.ok(tFull < Math.max(60, tSmall * 15), `${lang}: superlinear — ${small.length} chars ${tSmall.toFixed(1)} ms, ${code.length} chars ${tFull.toFixed(1)} ms`);
    }
  });
});
