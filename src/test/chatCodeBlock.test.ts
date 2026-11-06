import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { MiniElement, miniDocument } from './miniDom';

const EXT_ROOT = path.resolve(__dirname, '..', '..');

/** The code-block header of `media/chat.js` (path detection, the Apply / Create button), lifted out of the browser IIFE. */
function load(): { codePath: (info: string, prev?: string, first?: string) => string; codeBlock: (code: string, info: string, closed?: boolean, prev?: string) => string; codeApplyButton: (block: MiniElement, exists: boolean) => void } {
  const src = fs.readFileSync(path.join(EXT_ROOT, 'media', 'chat.js'), 'utf8');
  const cut = (from: string, to: string): string => {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a);
    assert.ok(a > 0 && b > a, `${from.trim()} … ${to.trim()} not found in media/chat.js`);
    return src.slice(a, b);
  };
  const line = (prefix: string): string => {
    const l = src.split('\n').find((x) => x.trim().startsWith(prefix));
    assert.ok(l, `${prefix} not found in media/chat.js`);
    return l;
  };
  const sandbox: Record<string, unknown> = { I: { apply: '<svg></svg>', plus: '<svg></svg>', copy: '<svg></svg>', insert: '<svg></svg>' }, highlight: (c: string) => c, normLang: (l: string) => l || 'text', langForPath: () => '' };
  vm.runInNewContext(`${line('const esc = ')}\n${cut('  /** A file path standing alone on the line before a fence', '  /** `NNN | text` lines')}\nout_ = { codePath, codeBlock, codeApplyButton };`, sandbox, { timeout: 5_000 });
  return sandbox.out_ as ReturnType<typeof load>;
}

suite('Chat code blocks: target file and Apply / Create', () => {
  test('the file comes from the fence info, a path line just before the fence, or a path comment on the first line', () => {
    const { codePath } = load();
    assert.strictEqual(codePath('ts src/a.ts'), 'src/a.ts');
    assert.strictEqual(codePath('json title="cfg/x.json"'), 'cfg/x.json');
    assert.strictEqual(codePath('', '`src/new.ts`:'), 'src/new.ts');
    assert.strictEqual(codePath('', '**src/new.ts**'), 'src/new.ts');
    assert.strictEqual(codePath('', '### src/utils/math.ts'), 'src/utils/math.ts');
    assert.strictEqual(codePath('', 'File: src/a.py'), 'src/a.py');
    assert.strictEqual(codePath('', 'Add this to `src/utils/math.ts`:'), 'src/utils/math.ts');
    assert.strictEqual(codePath('python', '', '# app.py'), 'app.py');
    assert.strictEqual(codePath('js', '', '// src/index.js'), 'src/index.js');
    assert.strictEqual(codePath('ts other.ts', '`src/new.ts`:'), 'other.ts', 'the fence wins');
    for (const prev of ['Here is the fix:', 'e.g.', 'Version 1.2', 'Update `dice.py` as follows:', 'See README.md for details']) {
      assert.strictEqual(codePath('', prev), '', `"${prev}" names no file`);
    }
    assert.strictEqual(codePath('python', '', '# compute the total'), '');
  });

  test('a block with a file says "Apply to <name>"; one without targets the active file', () => {
    const { codeBlock } = load();
    const doc = miniDocument();
    const host = doc.body.appendChild(doc.createElement('div'));
    host.innerHTML = codeBlock('x = 1', 'python', true, '`pkg/mod.py`:') + codeBlock('print(1)', 'python');
    const [withFile, without] = host.querySelectorAll('[data-code="apply"]');
    assert.strictEqual(withFile.dataset.target, 'pkg/mod.py');
    assert.strictEqual(withFile.getAttribute('aria-label'), 'Apply to mod.py');
    assert.strictEqual(without.dataset.target, undefined);
    assert.strictEqual(without.getAttribute('aria-label'), 'Apply to the active file');
  });

  test('once the host says the file does not exist, Apply becomes Create <path> (and back if it appears)', () => {
    const { codeBlock, codeApplyButton } = load();
    const doc = miniDocument();
    const host = doc.body.appendChild(doc.createElement('div'));
    host.innerHTML = codeBlock('x = 1', 'python src/new.py');
    const block = host.querySelector('.code')!;
    codeApplyButton(block, false);
    const b = block.querySelector('.code-head button[data-target]')!;
    assert.strictEqual(b.dataset.code, 'create');
    assert.strictEqual(b.getAttribute('aria-label'), 'Create src/new.py');
    assert.strictEqual(b.textContent, 'Create');
    codeApplyButton(block, true);
    assert.strictEqual(b.dataset.code, 'apply');
    assert.strictEqual(b.textContent, 'Apply');
  });
});
