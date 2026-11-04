import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const EXT_ROOT = path.resolve(__dirname, '..', '..');

/** Lifts one function declaration (two-space indented) out of the chat webview's IIFE source. */
function lift(src: string, name: string): string {
  const start = src.indexOf(`  function ${name}(`);
  assert.ok(start > 0, `${name} not found in media/chat.js`);
  const line = src.slice(start, src.indexOf('\n', start));
  if (line.trimEnd().endsWith('}')) { return line; }
  const end = src.indexOf('\n  }\n', start);
  assert.ok(end > start, `end of ${name} not found in media/chat.js`);
  return src.slice(start, end + 4);
}

suite('Chat image vision gate', () => {
  const src = fs.readFileSync(path.join(EXT_ROOT, 'media', 'chat.js'), 'utf8');
  const code = ['visionBlocked', 'addImageUrl'].map((n) => lift(src, n)).join('\n');

  function run(models: Array<{ id: string; name: string; supportsVision?: boolean }>, model: string, visionRouting: boolean) {
    const toasts: string[] = [];
    let loads = 0;
    const sandbox: Record<string, unknown> = {
      state: { models, visionRouting, images: [] },
      currentModel: () => models.find((m) => m.id === model) || null,
      toast: (msg: string) => toasts.push(msg),
      Image: class { set src(_: string) { loads++; } },
    };
    vm.runInNewContext(`${code}\naddImageUrl('shot.png', 'data:image/png;base64,AAAA');`, sandbox);
    return { toasts, loads };
  }

  test('a host-sent or dropped image is refused for a non-vision model without routing', () => {
    const r = run([{ id: 'a', name: 'coder' }], 'a', false);
    assert.strictEqual(r.loads, 0);
    assert.deepStrictEqual(r.toasts, ['coder cannot read images — pick a vision model']);
  });

  test('vision models, and routing to one, accept the image', () => {
    assert.strictEqual(run([{ id: 'a', name: 'llava', supportsVision: true }], 'a', false).loads, 1);
    assert.strictEqual(run([{ id: 'a', name: 'coder' }, { id: 'b', name: 'llava', supportsVision: true }], 'a', true).loads, 1);
    assert.strictEqual(run([{ id: 'a', name: 'coder' }, { id: 'b', name: 'llava', supportsVision: true }], 'a', false).loads, 0);
  });
});
