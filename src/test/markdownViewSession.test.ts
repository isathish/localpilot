import * as assert from 'assert';
import { validateViewerMessage } from '../ui/markdown/viewSession';

suite('Markdown reader: webview message validation', () => {
  test('saveAs keeps a valid SVG and treats a missing one as "save Markdown"', () => {
    assert.deepStrictEqual(validateViewerMessage({ type: 'saveAs', svg: '<svg/>', name: 'd' }), { type: 'saveAs', svg: '<svg/>', name: 'd' });
    assert.deepStrictEqual(validateViewerMessage({ type: 'saveAs' }), { type: 'saveAs', svg: undefined, name: undefined });
  });

  test('saveAs with an oversize or non-string SVG is dropped instead of saving the Markdown', () => {
    assert.strictEqual(validateViewerMessage({ type: 'saveAs', svg: 'x'.repeat(20 * 1024 * 1024 + 1) }), undefined);
    assert.strictEqual(validateViewerMessage({ type: 'saveAs', svg: 42 }), undefined);
    assert.strictEqual(validateViewerMessage({ type: 'saveAs', svg: null }), undefined);
  });
});
